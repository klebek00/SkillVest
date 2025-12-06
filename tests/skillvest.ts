import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { IsaContract } from "../target/types/isa_contract";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount
} from "@solana/spl-token";
import { assert } from "chai";

describe("isa_contract", () => {
  // Настройка провайдера
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.IsaContract as Program<IsaContract>;

  // --- Переменные для тестов ---
  const admin = provider.wallet as anchor.Wallet;
  const student = anchor.web3.Keypair.generate();
  const investor = anchor.web3.Keypair.generate();
  const university = anchor.web3.Keypair.generate();
  const oracle = anchor.web3.Keypair.generate();

  // Новые ключи для проверки смены админом
  const newOracle = anchor.web3.Keypair.generate();
  const newUniversity = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let studentAta: anchor.web3.PublicKey;
  let investorAta: anchor.web3.PublicKey;
  let universityAta: anchor.web3.PublicKey;
  let newUniversityAta: anchor.web3.PublicKey;

  let configPda: anchor.web3.PublicKey;
  let isaPda: anchor.web3.PublicKey;
  let vaultAta: anchor.web3.PublicKey;
  let investorStakePda: anchor.web3.PublicKey;

  const courseCost = new anchor.BN(10000000); // 10 токенов
  const percent = 10;
  const maxCap = new anchor.BN(15000000); // 15 токенов
  const investAmount = new anchor.BN(10000000);
  const salaryAmount = new anchor.BN(50000000); // 50 токенов

  // --- ФУНКЦИИ ЛОГИРОВАНИЯ ---
  const logAccountInfo = async (publicKey: anchor.web3.PublicKey, name: string) => {
    try {
      const balance = await provider.connection.getBalance(publicKey);
      console.log(`\n[Account Info] ${name}`);
      console.log(`  > Public Key: ${publicKey.toBase58()}`);
      console.log(`  > SOL Balance: ${balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    } catch (e) {
      console.error(`Error fetching info for ${name}:`, e);
    }
  };
  // ----------------------------

  before(async () => {
    // 1. Логирование и проверка баланса админа (оплачивает большинство транзакций)
    console.log(`\n======================================================`);
    console.log(`             STARTING SETUP (BEFORE ALL)              `);
    console.log(`======================================================`);
    await logAccountInfo(admin.publicKey, "ADMIN (Payer)");
    await logAccountInfo(student.publicKey, "Student");
    await logAccountInfo(investor.publicKey, "Investor");

    // 1.5. Явный AirDrop для Admin (для гарантии SOL в localnet)
    try {
      console.log("\n-> 1.5. Requesting 50 SOL for Admin (Guarantee)");
      const signature = await provider.connection.requestAirdrop(admin.publicKey, 50 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(signature, 'confirmed');
      console.log("Admin Airdrop confirmed.");
      await logAccountInfo(admin.publicKey, "ADMIN (Payer) AFTER AIRDROP");
    } catch (e) {
      console.warn("WARN: Admin AirDrop failed or was not necessary.");
    }

    try {
      console.log("\n-> 1.7. Requesting 5 SOL for Investor (Payer for Stake)");
      const signature = await provider.connection.requestAirdrop(investor.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(signature, 'confirmed');
      console.log("Investor Airdrop confirmed.");
      // logAccountInfo(investor.publicKey, "Investor AFTER AIRDROP"); // Можно добавить, если хотите
    } catch (e) {
      console.warn("WARN: Investor AirDrop failed.");
    }

    try {
      console.log("\n-> 1.6. Requesting 10 SOL for Student (Payer for ISA)");
      const signature = await provider.connection.requestAirdrop(student.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(signature, 'confirmed');
      console.log("Student Airdrop confirmed.");
      await logAccountInfo(student.publicKey, "Student AFTER AIRDROP");
    } catch (e) {
      console.warn("WARN: Student AirDrop failed.");
    }

    // 2. Создание токена
    console.log("\n-> 2. Creating Mint (Payer: Admin)");
    mint = await createMint(provider.connection, admin.payer, admin.publicKey, null, 6);
    console.log(`Mint Address: ${mint.toBase58()}`);


    // 3. Создание ATA (Associated Token Accounts)
    console.log("\n-> 3. Creating ATA (Payer for ALL: Admin.payer)");

    // ВАЖНО: Используем admin.payer для оплаты создания всех ATA

    studentAta = await createAssociatedTokenAccount(
      provider.connection,
      admin.payer, // FIX: Admin платит за создание
      mint,
      student.publicKey
    );
    console.log(`Student ATA: ${studentAta.toBase58()}`);

    investorAta = await createAssociatedTokenAccount(
      provider.connection,
      admin.payer, // FIX: Admin платит за создание
      mint,
      investor.publicKey
    );
    console.log(`Investor ATA: ${investorAta.toBase58()}`);

    universityAta = await createAssociatedTokenAccount(
      provider.connection,
      admin.payer, // FIX: Admin платит за создание
      mint,
      university.publicKey
    );
    console.log(`University ATA: ${universityAta.toBase58()}`);

    // ATA для нового университета (для теста смены)
    newUniversityAta = await createAssociatedTokenAccount(
      provider.connection,
      admin.payer, // FIX: Admin платит за создание
      mint,
      newUniversity.publicKey
    );
    console.log(`New University ATA: ${newUniversityAta.toBase58()}`);


    // 4. Минт начальных балансов
    console.log("\n-> 4. Minting Initial Balances (Payer: Admin)");
    await mintTo(provider.connection, admin.payer, mint, investorAta, admin.publicKey, 20000000);
    await mintTo(provider.connection, admin.payer, mint, studentAta, admin.publicKey, 10000000);
    console.log("Minting complete.");


    // 5. Вычисление PDA
    console.log("\n-> 5. Calculating PDAs");
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    console.log(`Config PDA: ${configPda.toBase58()}`);

    [isaPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("isa"), student.publicKey.toBuffer()],
      program.programId
    );
    console.log(`ISA PDA: ${isaPda.toBase58()}`);

    vaultAta = await getAssociatedTokenAddress(mint, isaPda, true);
    console.log(`Vault ATA (for ISA PDA): ${vaultAta.toBase58()}`);

    [investorStakePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), isaPda.toBuffer(), investor.publicKey.toBuffer()],
      program.programId
    );
    console.log(`Investor Stake PDA: ${investorStakePda.toBase58()}`);
    console.log(`======================================================`);
  });

  // ... (Остальные тесты без изменений)
  // ...

  it("Initialize Config", async () => {
    // 🟢 FIX: Используем 'as any', чтобы обойти ошибку TypeScript
    await program.methods
      .initializeConfig(oracle.publicKey, university.publicKey)
      .accounts({
        config: configPda,
        payer: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const configAccount = await program.account.isaConfig.fetch(configPda);
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.oracle.equals(oracle.publicKey));
    assert.ok(configAccount.university.equals(university.publicKey));
  });

  // --- ТЕСТЫ АДМИНА ---
  it("Admin sets new Oracle", async () => {
    await program.methods
      .setOracle(newOracle.publicKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
      } as any)
      .rpc();

    const configAccount = await program.account.isaConfig.fetch(configPda);
    assert.ok(configAccount.oracle.equals(newOracle.publicKey));

    // Возвращаем старого оракула обратно, чтобы не ломать следующие тесты
    await program.methods
      .setOracle(oracle.publicKey)
      .accounts({ config: configPda, admin: admin.publicKey } as any)
      .rpc();
  });

  it("Admin sets new University", async () => {
    await program.methods
      .setUniversity(newUniversity.publicKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey
      } as any)
      .rpc();

    const configAccount = await program.account.isaConfig.fetch(configPda);
    assert.ok(configAccount.university.equals(newUniversity.publicKey));

    // Возвращаем старый университет
    await program.methods
      .setUniversity(university.publicKey)
      .accounts({ config: configPda, admin: admin.publicKey } as any)
      .rpc();
  });
  // --------------------

  it("Initialize ISA", async () => {
    // await createAssociatedTokenAccount(
    //   provider.connection,
    //   student,
    //   mint,
    //   isaPda
    // );

    await program.methods
      .initializeIsa(courseCost, percent, maxCap)
      .accounts({
        isaState: isaPda,
        vault: vaultAta,
        mint: mint,
        student: student.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([student])
      .rpc();

    const isaAccount = await program.account.isaState.fetch(isaPda);
    assert.equal(isaAccount.courseCost.toNumber(), courseCost.toNumber());
  });

  it("Invest Funds", async () => {
    await program.methods
      .invest(investAmount)
      .accounts({
        isaState: isaPda,
        investorStake: investorStakePda,
        investor: investor.publicKey,
        investorAta: investorAta,
        vault: vaultAta,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([investor])
      .rpc();

    const isaAccount = await program.account.isaState.fetch(isaPda);
    assert.equal(isaAccount.totalInvested.toNumber(), investAmount.toNumber());
  });

  it("Release Funds to University", async () => {
    await program.methods
      .releaseFundsToUniversity()
      .accounts({
        isaState: isaPda,
        vault: vaultAta,
        config: configPda,
        universityAta: universityAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const isaAccount = await program.account.isaState.fetch(isaPda);
    assert.equal(isaAccount.status, 1); // StudyingPaid

    const vaultInfo = await getAccount(provider.connection, vaultAta);
    assert.equal(Number(vaultInfo.amount), 0);

    const uniInfo = await getAccount(provider.connection, universityAta);
    assert.equal(Number(uniInfo.amount), investAmount.toNumber());
  });

  it("Update Salary (by Oracle)", async () => {
    await program.methods
      .updateSalary(salaryAmount)
      .accounts({
        isaState: isaPda,
        config: configPda,
        oracle: oracle.publicKey,
      } as any)
      .signers([oracle])
      .rpc();

    const isaAccount = await program.account.isaState.fetch(isaPda);
    assert.equal(isaAccount.lastSalary.toNumber(), salaryAmount.toNumber());
  });

  it("Student Pays Share", async () => {
    const expectedPayment = salaryAmount.toNumber() * (percent / 100);

    await program.methods
      .payShare()
      .accounts({
        isaState: isaPda,
        student: student.publicKey,
        studentAta: studentAta,
        vault: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([student])
      .rpc();

    const isaAccount = await program.account.isaState.fetch(isaPda);
    assert.equal(isaAccount.alreadyPaid.toNumber(), expectedPayment);
  });

  it("Distribute Payments to Investors", async () => {
    const amountToDistribute = new anchor.BN(5000000);
    const initialInvestorBalance = (await getAccount(provider.connection, investorAta)).amount;

    await program.methods
      .distributePayments(amountToDistribute)
      .accounts({
        isaState: isaPda,
        vault: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .remainingAccounts([
        { pubkey: investorStakePda, isWritable: false, isSigner: false },
        { pubkey: investorAta, isWritable: true, isSigner: false },
      ])
      .rpc();

    const isaAccount = await program.account.isaState.fetch(isaPda);
    assert.equal(isaAccount.totalDistributed.toNumber(), amountToDistribute.toNumber());

    const finalInvestorBalance = (await getAccount(provider.connection, investorAta)).amount;
    const diff = Number(finalInvestorBalance) - Number(initialInvestorBalance);
    assert.equal(diff, amountToDistribute.toNumber());
  });
});