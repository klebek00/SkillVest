import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ISAService } from "./backend/api"; // Путь к api.ts
import { IsaContract } from "./target/types/isa_contract"; 
import {
    createMint,
    createAssociatedTokenAccount,
    mintTo,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    getAccount
} from "@solana/spl-token";
import { Connection, Keypair } from "@solana/web3.js";

// ----------------------------------------------------------------------
// 1. НАСТРОЙКА ГЛОБАЛЬНЫХ ПЕРЕМЕННЫХ И ПРОВАЙДЕРА
// ----------------------------------------------------------------------

// 🛑 ИСПРАВЛЕНИЕ ОШИБКИ ANCHOR_PROVIDER_URL
// Явно указываем URL локальной сети
const RPC_URL = "http://127.0.0.1:8899";
const connection = new Connection(RPC_URL, "confirmed");

// Определяем главного плательщика (Admin). Используем Keypair.generate()
// для простоты. Это будет Keypair, который подписывает транзакции.
const adminKeypair = Keypair.generate(); 
const adminWallet = new anchor.Wallet(adminKeypair);

// Инициализируем провайдер вручную, используя нашу Connection и Wallet
const provider = new anchor.AnchorProvider(
    connection,
    adminWallet,
    { preflightCommitment: "confirmed" }
);
anchor.setProvider(provider);

// Загрузка программы
const program = anchor.workspace.IsaContract as Program<IsaContract>;

// --- Keypairs и Константы ---
// Теперь 'admin' — это Keypair, используемый для подписи и оплаты
const admin = adminKeypair; 
const student = Keypair.generate();
const investor = Keypair.generate();
const investor2 = Keypair.generate();
const university = Keypair.generate();
const oracle = Keypair.generate();

let mint: anchor.web3.PublicKey;
let studentAta: anchor.web3.PublicKey;
let investorAta: anchor.web3.PublicKey;
let investor2Ata: anchor.web3.PublicKey;
let universityAta: anchor.web3.PublicKey;
let configPda: anchor.web3.PublicKey;
let isaPda: anchor.web3.PublicKey;
let vaultAta: anchor.web3.PublicKey;
let investorStakePda: anchor.web3.PublicKey;
let investor2StakePda: anchor.web3.PublicKey;

const courseCost = new anchor.BN(15000000); // 15 токенов
const percent = 10;
const maxCap = new anchor.BN(50000000); // 50 токенов
const investAmount = new anchor.BN(10000000); // Инвестор 1: 10 токенов

// --- Экземпляры ISAService (Клиент) ---
let adminService: ISAService;
let studentService: ISAService;
let investorService: ISAService;


// --- ФУНКЦИЯ ЛОГИРОВАНИЯ ---
const logAccountInfo = async (publicKey: anchor.web3.PublicKey, name: string) => {
    try {
        const balance = await connection.getBalance(publicKey);
        console.log(`\n[Account Info] ${name}`);
        console.log(`  > Public Key: ${publicKey.toBase58()}`);
        console.log(`  > SOL Balance: ${balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    } catch (e) {
        console.error(`Error fetching info for ${name}:`, e);
    }
};

// ----------------------------------------------------------------------
// 2. ОСНОВНАЯ ФУНКЦИЯ КЛИЕНТСКОГО ТЕСТА
// ----------------------------------------------------------------------

async function main() {
    console.log(`\n======================================================`);
    console.log(`       🚀 ЗАПУСК КЛИЕНТСКОГО ДЕМОНСТРАЦИОННОГО СКРИПТА 🚀 `);
    console.log(`======================================================`);

    // =================================================================
    // A. НАСТРОЙКА ТЕСТОВОЙ СРЕДЫ
    // =================================================================
    
    console.log("\n--- 1. Инициализация кошельков и AirDrop ---");

    // ИСПРАВЛЕНИЕ ОШИБКИ: Добавлены oracle.publicKey и university.publicKey в airdrop
    const airDropPromises = [
        admin.publicKey, 
        student.publicKey, 
        investor.publicKey, 
        investor2.publicKey,
        oracle.publicKey,
        university.publicKey
    ].map(pubkey => 
        connection.requestAirdrop(pubkey, 10 * anchor.web3.LAMPORTS_PER_SOL)
    );
    const airDropSignatures = await Promise.all(airDropPromises);
    await Promise.all(airDropSignatures.map(sig => connection.confirmTransaction(sig, 'confirmed')));
    
    await logAccountInfo(admin.publicKey, "ADMIN");
    
    // 2. Создание токена, ATA и Минт балансов
    console.log("\n--- 2. Создание Mint, ATA и Минт балансов ---");
    mint = await createMint(connection, admin, admin.publicKey, null, 6);
    console.log(`✅ Mint Address: ${mint.toBase58()}`);

    studentAta = await createAssociatedTokenAccount(connection, admin, mint, student.publicKey);
    investorAta = await createAssociatedTokenAccount(connection, admin, mint, investor.publicKey);
    investor2Ata = await createAssociatedTokenAccount(connection, admin, mint, investor2.publicKey);
    universityAta = await createAssociatedTokenAccount(connection, admin, mint, university.publicKey);

    // Добавляем токены
    await mintTo(connection, admin, mint, investorAta, admin.publicKey, 20000000, [admin]); 
    await mintTo(connection, admin, mint, investor2Ata, admin.publicKey, 10000000, [admin]); 
    // Студенту нужно много, чтобы покрыть 50 токенов Max Cap для теста
    await mintTo(connection, admin, mint, studentAta, admin.publicKey, 500000000, [admin]); 
    console.log("✅ Токены начислены инвесторам и студенту.");

    // 3. Вычисление PDA
    console.log("\n--- 3. Вычисление PDA ---");
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [isaPda] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("isa"), student.publicKey.toBuffer()], program.programId);
    vaultAta = await getAssociatedTokenAddress(mint, isaPda, true);
    [investorStakePda] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("stake"), isaPda.toBuffer(), investor.publicKey.toBuffer()], program.programId);
    
    console.log(`ISA PDA: ${isaPda.toBase58()}`);
    
    // 4. Инициализация ISAService
    const oracleWallet = new anchor.Wallet(oracle);
    const universityWallet = new anchor.Wallet(university);

    adminService = new ISAService(connection, adminWallet);
    studentService = new ISAService(connection, new anchor.Wallet(student));
    investorService = new ISAService(connection, new anchor.Wallet(investor));
    const investor2Service = new ISAService(connection, new anchor.Wallet(investor2));
    const oracleService = new ISAService(connection, oracleWallet);
    const universityService = new ISAService(connection, universityWallet);
    
    // =================================================================
    // B. ТРАНЗАКЦИИ (Установка начального состояния)
    // =================================================================

    console.log("\n\n=======================================================");
    console.log("             B. ВЫЗОВЫ ТРАНЗАКЦИЙ (ЗАПИСЬ)             ");
    console.log("=======================================================");

    // 1. Initialize Config
    console.log("\n-> 1. Initialize Config (Admin)");
    const txConfig = await adminService.initializeConfig(oracle.publicKey, university.publicKey);
    console.log(`   TX: ${txConfig.slice(0, 10)}...`);

    // 2. Initialize ISA
    console.log("\n-> 2. Initialize ISA (Student) - Course Cost: 15 токенов, Max Cap: 50 токенов");
    const txIsa = await studentService.initializeIsa(mint, courseCost.toNumber(), percent, maxCap.toNumber());
    console.log(`   TX: ${txIsa.slice(0, 10)}...`);

    // 3. Invest Funds (Investor 1: 10 токенов)
    console.log("\n-> 3. Invest Funds (Investor 1: 10 токенов)");
    const txInvest1 = await investorService.invest(student.publicKey, investAmount.toNumber(), mint);
    console.log(`   TX: ${txInvest1.slice(0, 10)}...`);


    // =================================================================
    // C. ДЕМОНСТРАЦИЯ КЛИЕНТСКИХ МЕТОДОВ (ЧТЕНИЕ)
    // =================================================================
    
    console.log("\n\n=======================================================");
    console.log("           C. ДЕМОНСТРАЦИЯ МЕТОДОВ ЧТЕНИЯ (ФРОНТЕНД)      ");
    console.log("=======================================================");

    // 1. getIsaState (Необработанные данные)
    console.log("\n--- 1. getIsaState: Необработанное состояние ISA (для отладки) ---");
    const rawState = await studentService.getIsaState(student.publicKey);
    console.log(`\tИнвестировано (BN): ${rawState.totalInvested.toString()}`);
    
    // 2. getFundingStatus (Агрегированные данные для Фронта)
    console.log("\n--- 2. getFundingStatus: Агрегированный статус финансирования ---");
    const fundingStatus = await studentService.getFundingStatus(student.publicKey);
    
    const remainingHuman = fundingStatus.remainingToInvest / 1000000;
    console.log(`\t  Осталось инвестировать: ${remainingHuman} токенов (Ожидается 5)`);
    
    // 3. getAllStakesForIsa (Доли инвесторов)
    console.log("\n--- 3. getAllStakesForIsa: Доли инвесторов ---");
    const stakes = await investorService.getAllStakesForIsa(student.publicKey);
    console.log(`\tНайдено долей инвесторов: ${stakes.length}`);
    
    // =================================================================
    // D. ПОЛНОЕ ФИНАНСИРОВАНИЕ
    // =================================================================
    
    console.log("\n\n--- 4. Дополнительное инвестирование (Инвестор 2: 5 токенов) ---");
    const txInvest2 = await investor2Service.invest(student.publicKey, 5000000, mint); // 5M
    console.log(`   TX: ${txInvest2.slice(0, 10)}...`);

    console.log("\n--- 5. getFundingStatus: Обновленный статус после полного финансирования ---");
    const finalFundingStatus = await studentService.getFundingStatus(student.publicKey);
    const finalRemainingHuman = finalFundingStatus.remainingToInvest / 1000000;
    
    console.log(`\tОсталось инвестировать: ${finalRemainingHuman} токенов`); // Должно быть 0
    console.log(`\tПолностью ли профинансирован: ${finalFundingStatus.isFullyFunded ? "ДА" : "НЕТ"}`);
    
    // =================================================================
    // E. ПОЛНЫЙ ЦИКЛ ISA, ВЫПЛАТЫ И ОБРАБОТКА ОШИБОК
    // =================================================================
    
    console.log("\n\n=======================================================");
    console.log("    E. ПОЛНЫЙ ЦИКЛ ISA, ВЫПЛАТЫ И ОБРАБОТКА ОШИБОК       ");
    console.log("=======================================================");

    // 1. Освобождение средств (Vault -> University)
    console.log("\n-> 6. Release Funds (Admin/ISA fully funded)");
    const txRelease = await adminService.releaseFunds(student.publicKey, universityAta);
    console.log(`   TX: ${txRelease.slice(0, 10)}...`);
    let isaStateRelease = await studentService.getIsaState(student.publicKey);
    console.log(`   [Статус] После Release Funds: ${isaStateRelease.status} (Ожидается 1: StudyingPaid)`);


    // 2. Обновление зарплаты (Oracle)
    const salaryAmount = 1000000; // Зарплата: 1 токен (10% = 0.1 токена)
    console.log("\n-> 7. Update Salary (Oracle) - Студент трудоустроен");
    // ТЕПЕРЬ С РАБОТАЮЩИМ AIRDROP'ом
    const txSalary = await oracleService.updateSalary(student.publicKey, salaryAmount);
    console.log(`   TX: ${txSalary.slice(0, 10)}...`);
    let isaStateWorking = await studentService.getIsaState(student.publicKey);
    console.log(`   [Статус] После Update Salary: ${isaStateWorking.status} (Ожидается 2: Working)`);
    

    // 3. Выплата доли студентом (Student)
    console.log("\n-> 8. Pay Share (Student) - Первая выплата (0.1 токена)");
    const studentBalanceBefore = Number((await getAccount(connection, studentAta)).amount);
    const vaultBalanceBefore = Number((await getAccount(connection, vaultAta)).amount);
    const txPayShare = await studentService.payShare(student.publicKey, mint);
    console.log(`   TX: ${txPayShare.slice(0, 10)}...`);
    
    const vaultBalanceAfter = Number((await getAccount(connection, vaultAta)).amount);
    const paidAmount = vaultBalanceAfter - vaultBalanceBefore;
    console.log(`   [Проверка] Выплачено в Vault: ${paidAmount / 1000000} токенов (Ожидается 0.1)`);
    let isaStatePaid = await studentService.getIsaState(student.publicKey);
    console.log(`   [Накоплено] Already Paid: ${isaStatePaid.alreadyPaid.toNumber() / 1000000} токенов`);


    // 4. Распределение платежей (Admin)
    console.log("\n-> 9. Distribute Payments (Admin) - Инвесторам");
    const txDistribute = await adminService.distributePayments(student.publicKey, paidAmount, mint);
    console.log(`   TX: ${txDistribute.slice(0, 10)}...`);
    let isaStateDistributed = await studentService.getIsaState(student.publicKey);
    console.log(`   [Накоплено] Total Distributed: ${isaStateDistributed.totalDistributed.toNumber() / 1000000} токенов`);

    
    // 5. Демонстрация статуса Delinquency и восстановления
    console.log("\n--- Демонстрация Delinquency (Просрочка) и восстановления ---");
    
    // Сценарий A: Отчет о просрочке (Нужен статус Working, Unemployed)
    console.log("-> 10. Report Delinquency (Oracle)");
    const txDelinquency = await oracleService.reportDelinquency(student.publicKey);
    console.log(`   TX: ${txDelinquency.slice(0, 10)}...`);

    let isaStateDelinquent = await studentService.getIsaState(student.publicKey);
    console.log(`   [Статус] После Delinquency: ${isaStateDelinquent.status} (Ожидается 3)`); // 3: Delinquent
    
    // Сценарий B: Студент выплачивает долю (статус должен стать Working: 2)
    console.log("-> 11. Pay Share (Student) - Восстановление из Delinquent");
    await studentService.payShare(student.publicKey, mint);
    let isaStateRestored = await studentService.getIsaState(student.publicKey);
    console.log(`   [Статус] После PayShare: ${isaStateRestored.status} (Ожидается 2: Working)`);

    // 6. Демонстрация reportDropout
    console.log("\n-> 12. Report Dropout (University)");
    const txDropout = await universityService.reportDropout(student.publicKey);
    console.log(`   TX: ${txDropout.slice(0, 10)}...`);
    let isaStateDropout = await studentService.getIsaState(student.publicKey);
    console.log(`   [Статус] После Dropout: ${isaStateDropout.status} (Ожидается 4)`); // 4: DroppedOut
    console.log(`   [Проверка] Max Cap: ${isaStateDropout.maxCap.toString()} (Ожидается 0)`); // Обязательства обнулены

    // 7. Проверка обработки ошибок
    console.log("\n--- Проверка Ошибок Контракта ---");
    
    // Ошибка 1: Попытка инвестировать больше, чем course_cost
    try {
        console.log("-> 13. [ОШИБКА] Invest: Сверх лимита (Max Cap = 0 после Dropout)");
        await investorService.invest(student.publicKey, 1000000, mint); 
        console.error("❌ ОШИБКА: Ожидался сбой, но транзакция прошла.");
    } catch (e: any) {
        if (e.logs && e.logs.some((log: string) => log.includes("FundingExceedsCourseCost"))) {
            console.log("   ✅ ОШИБКА: FundingExceedsCourseCost (Ожидаемо, Max Cap = 0).");
        } else {
            console.log("   ❌ ОШИБКА: Неизвестный сбой при проверке лимита:", e.message);
        }
    }
    
    // Ошибка 2: Вызов setOracle не админом
    try {
        console.log("\n-> 14. [ОШИБКА] Set Oracle не админом (Student)");
        await studentService.setOracle(Keypair.generate().publicKey);
        console.error("❌ ОШИБКА: Ожидался сбой, но транзакция прошла.");
    } catch (e: any) {
         if (e.logs && e.logs.some((log: string) => log.includes("UnauthorizedAdmin"))) {
            console.log("   ✅ ОШИБКА: UnauthorizedAdmin (Ожидаемо).");
        } else {
            console.log("   ❌ ОШИБКА: Неизвестный сбой при проверке прав:", e.message);
        }
    }
    
    // 8. Смена Оракула (Успешный кейс)
    const newOracle = Keypair.generate();
    console.log("\n-> 15. Set Oracle (Admin) - Смена Оракула");
    const txSetOracle = await adminService.setOracle(newOracle.publicKey);
    console.log(`   TX: ${txSetOracle.slice(0, 10)}...`);
    
    console.log("\n=======================================================");
    console.log("             ✅ Демонстрация успешно завершена!             ");
    console.log("=======================================================");
}

main().catch(err => {
    console.error("\n❌ Произошла критическая ошибка в скрипте main:", err);
    // Печатаем логи транзакции, если это ошибка Anchor
    if (err.logs) {
        console.error("Logs:", err.logs.join("\n"));
    }
    process.exit(1);
});