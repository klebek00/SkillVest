import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import { 
    PublicKey, 
    SystemProgram, 
    SYSVAR_RENT_PUBKEY, 
    Keypair 
} from "@solana/web3.js";
import { 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID, 
    getAssociatedTokenAddressSync 
} from "@solana/spl-token";

// -------------------------------------------------------------------------
// 1. ТИПИЗАЦИЯ IDL
// -------------------------------------------------------------------------

interface ISAConfig { 
    admin: PublicKey; 
    oracle: PublicKey; 
    university: PublicKey; 
    bump: number; 
}
interface InvestorStake { 
    isa: PublicKey; 
    investor: PublicKey; 
    amount: anchor.BN; 
    initialized: boolean; 
    bump: number; 
}
interface IsaState { 
    owner: PublicKey; 
    tokenMint: PublicKey; 
    vault: PublicKey; 
    courseCost: anchor.BN; 
    percent: number; 
    maxCap: anchor.BN; 
    totalInvested: anchor.BN; 
    alreadyPaid: anchor.BN; 
    totalDistributed: anchor.BN; 
    lastSalary: anchor.BN; 
    status: number; 
    bump: number; 
}

type IsaContract = anchor.Idl & {
    accounts: [
        { name: "ISAConfig", type: { fields: any[] } },
        { name: "InvestorStake", type: { fields: any[] } },
        { name: "IsaState", type: { fields: any[] } }
    ];
};

type TypedProgram = Program<IsaContract> & {
    account: {
        isaConfig: { fetch: (publicKey: PublicKey) => Promise<ISAConfig> };
        investorStake: { 
            fetch: (publicKey: PublicKey) => Promise<InvestorStake>;
            all: (filters: any[]) => Promise<Array<{ publicKey: PublicKey, account: InvestorStake }>>;
        };
        isaState: { 
            fetch: (publicKey: PublicKey) => Promise<IsaState>;
        };
    };
};

// -------------------------------------------------------------------------
// 2. ИМПОРТ IDL И КЛАСС СЕРВИСА
// -------------------------------------------------------------------------

// Предполагаем, что ваш IDL лежит в target/idl/isa_contract.json
import idlJson from "../target/idl/isa_contract.json";
const idl = idlJson as Idl;

export class ISAService {
    private program: TypedProgram;
    private provider: anchor.AnchorProvider;

    constructor(connection: anchor.web3.Connection, wallet: anchor.Wallet) {
        this.provider = new anchor.AnchorProvider(connection, wallet, { preflightCommitment: "processed" });
        this.program = new Program(idl, this.provider) as TypedProgram;
    }

    // --- ХЕЛПЕРЫ ДЛЯ PDA ---

    private getConfigPda() {
        return PublicKey.findProgramAddressSync([Buffer.from("config")], this.program.programId)[0];
    }

    private getIsaPda(student: PublicKey) {
        return PublicKey.findProgramAddressSync([Buffer.from("isa"), student.toBuffer()], this.program.programId)[0];
    }

    private getStakePda(isa: PublicKey, investor: PublicKey) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("stake"), isa.toBuffer(), investor.toBuffer()],
            this.program.programId
        )[0];
    }

    // =========================================================================
    // --- МЕТОДЫ ДЛЯ ЧТЕНИЯ ДАННЫХ (ФРОНТЕНД) ---
    // =========================================================================

    /**
     * Загружает необработанное состояние ISA аккаунта.
     * @param student - Pubkey студента
     * @returns Promise<IsaState>
     */
    async getIsaState(student: PublicKey): Promise<IsaState> {
        const isaPda = this.getIsaPda(student);
        return this.program.account.isaState.fetch(isaPda);
    }
    
    /**
     * Возвращает агрегированную информацию о финансировании для отображения на фронтенде.
     * Включает вычисленное поле 'remainingToInvest'.
     * @param student - Pubkey студента
     * @returns Объект с ключевыми полями.
     */
    async getFundingStatus(student: PublicKey) {
        try {
            const isaAccount = await this.getIsaState(student);
            
            // Преобразование BN в числа для удобства JS/TS
            const totalInvested = isaAccount.totalInvested.toNumber();
            const courseCost = isaAccount.courseCost.toNumber();
            const maxCap = isaAccount.maxCap.toNumber();
            
            // Ключевая информация для фронтенда: сколько еще нужно инвестировать
            const remainingToInvest = Math.max(0, courseCost - totalInvested);
            const isFullyFunded = remainingToInvest === 0;

            return {
                student: isaAccount.owner.toBase58(),
                tokenMint: isaAccount.tokenMint.toBase58(),
                courseCost: courseCost,
                totalInvested: totalInvested,
                remainingToInvest: remainingToInvest, // <-- Количество, которое нужно инвестировать
                percent: isaAccount.percent,
                maxCap: maxCap,
                status: isaAccount.status,
                isFullyFunded: isFullyFunded,
                isaPda: this.getIsaPda(student).toBase58(),
            };
        } catch (e) {
            // Обработка случая, когда аккаунт не найден (например, 404)
            throw new Error(`ISA State not found for student ${student.toBase58()}. It may not be initialized.`);
        }
    }
    
    /**
     * Загружает список всех аккаунтов InvestorStake, связанных с данным ISA.
     * @param student - Pubkey студента, для которого ищется ISA
     * @returns Список объектов { publicKey, account: InvestorStake }
     */
    async getAllStakesForIsa(student: PublicKey): Promise<Array<{ publicKey: PublicKey, account: InvestorStake }>> {
        const isaPda = this.getIsaPda(student);
        return this.program.account.investorStake.all([
            {
                // Фильтр по полю 'isa' (Pubkey isa находится со смещением 8 байт после дискриминатора)
                memcmp: {
                    offset: 8, 
                    bytes: isaPda.toBase58(),
                },
            },
        ]);
    }
    
    // =========================================================================
    // --- МЕТОДЫ ТРАНЗАКЦИЙ (Остались без изменений) ---
    // =========================================================================
    
    async initializeConfig(oracle: PublicKey, university: PublicKey): Promise<string> {
        const configPda = this.getConfigPda();
        return await this.program.methods
            .initializeConfig(oracle, university)
            .accounts({
                config: configPda,
                payer: this.provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    async setOracle(newOracleKey: PublicKey): Promise<string> {
        return await this.program.methods
            .setOracle(newOracleKey)
            .accounts({
                config: this.getConfigPda(),
                admin: this.provider.wallet.publicKey,
            })
            .rpc();
    }
    
    async setUniversity(newUniversityKey: PublicKey): Promise<string> {
        return await this.program.methods
            .setUniversity(newUniversityKey)
            .accounts({
                config: this.getConfigPda(),
                admin: this.provider.wallet.publicKey,
            })
            .rpc();
    }

    async initializeIsa(mint: PublicKey, courseCost: number, percent: number, maxCap: number): Promise<string> {
        const student = this.provider.wallet.publicKey;
        const isaPda = this.getIsaPda(student);
        const vault = getAssociatedTokenAddressSync(mint, isaPda, true);

        return await this.program.methods
            .initializeIsa(new anchor.BN(courseCost), percent, new anchor.BN(maxCap))
            .accounts({
                isaState: isaPda,
                vault: vault,
                mint: mint,
                student: student,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            })
            .rpc();
    }

    async payShare(student: PublicKey, mint: PublicKey): Promise<string> {
        const isaPda = this.getIsaPda(student);
        const isaAccount = await this.program.account.isaState.fetch(isaPda); 
        
        const studentAta = getAssociatedTokenAddressSync(mint, student);

        return await this.program.methods
            .payShare()
            .accounts({
                isaState: isaPda,
                student: this.provider.wallet.publicKey,
                studentAta: studentAta,
                vault: isaAccount.vault,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }

    async invest(student: PublicKey, amount: number, mint: PublicKey): Promise<string> {
        const investor = this.provider.wallet.publicKey;
        const isaPda = this.getIsaPda(student);
        const stakePda = this.getStakePda(isaPda, investor);
        const investorAta = getAssociatedTokenAddressSync(mint, investor);
        const isaAccount = await this.program.account.isaState.fetch(isaPda);

        return await this.program.methods
            .invest(new anchor.BN(amount))
            .accounts({
                isaState: isaPda,
                investorStake: stakePda,
                investor: investor,
                investorAta: investorAta,
                vault: isaAccount.vault,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            })
            .rpc();
    }

    async updateSalary(student: PublicKey, salary: number): Promise<string> {
        const isaPda = this.getIsaPda(student);
        return await this.program.methods
            .updateSalary(new anchor.BN(salary))
            .accounts({
                isaState: isaPda,
                config: this.getConfigPda(),
                oracle: this.provider.wallet.publicKey, 
            })
            .rpc();
    }

    async reportDelinquency(student: PublicKey): Promise<string> {
        const isaPda = this.getIsaPda(student);

        return await this.program.methods
            .reportDelinquency()
            .accounts({
                isaState: isaPda,
                config: this.getConfigPda(),
                oracle: this.provider.wallet.publicKey, 
            })
            .rpc();
    }
    
    async reportDropout(student: PublicKey): Promise<string> {
        const isaPda = this.getIsaPda(student);

        return await this.program.methods
            .reportDropout()
            .accounts({
                isaState: isaPda,
                config: this.getConfigPda(),
                university: this.provider.wallet.publicKey, 
            })
            .rpc();
    }

    async releaseFunds(student: PublicKey, universityAta: PublicKey): Promise<string> {
        const isaPda = this.getIsaPda(student);
        const isaAccount = await this.program.account.isaState.fetch(isaPda);

        return await this.program.methods
            .releaseFundsToUniversity()
            .accounts({
                isaState: isaPda,
                vault: isaAccount.vault,
                config: this.getConfigPda(),
                universityAta: universityAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }
    
    async distributePayments(student: PublicKey, amountToDistribute: number, mint: PublicKey): Promise<string> {
        const isaPda = this.getIsaPda(student);
        const isaAccount = await this.program.account.isaState.fetch(isaPda);

        const allStakes = await this.program.account.investorStake.all([
            {
                memcmp: {
                    offset: 8, 
                    bytes: isaPda.toBase58(),
                },
            },
        ]);

        const remainingAccounts: anchor.web3.AccountMeta[] = [];
        for (const stake of allStakes) {
            
            remainingAccounts.push({
                pubkey: stake.publicKey,
                isWritable: true, 
                isSigner: false,
            });
            
            const investorAta = getAssociatedTokenAddressSync(mint, stake.account.investor);
            remainingAccounts.push({
                pubkey: investorAta, 
                isWritable: true,
                isSigner: false,
            });
        }
        
        if (remainingAccounts.length === 0) {
            throw new Error("No investors found for this ISA.");
        }

        return await this.program.methods
            .distributePayments(new anchor.BN(amountToDistribute))
            .accounts({
                isaState: isaPda,
                vault: isaAccount.vault,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .remainingAccounts(remainingAccounts)
            .rpc();
    }
}