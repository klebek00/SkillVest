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
  // ... (существующие переменные: admin, student, investor, university, oracle)

  // ...


  const investAmount2 = new anchor.BN(5000000); // <-- 5 токенов (меньше первого инвестора)
  // ...
  // --- Переменные для тестов ---
  const admin = provider.wallet as anchor.Wallet;
  const student = anchor.web3.Keypair.generate();
  const investor = anchor.web3.Keypair.generate();
  const investor2 = anchor.web3.Keypair.generate(); // <-- НОВЫЙ ИНВЕСТОР
  const university = anchor.web3.Keypair.generate();
  const oracle = anchor.web3.Keypair.generate();

  // Новые ключи для проверки смены админом
  const newOracle = anchor.web3.Keypair.generate();
  const newUniversity = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let studentAta: anchor.web3.PublicKey;
  let investorAta: anchor.web3.PublicKey;
  let investor2Ata: anchor.web3.PublicKey; // <-- Его токеновый аккаунт
  let universityAta: anchor.web3.PublicKey;
  let newUniversityAta: anchor.web3.PublicKey;

  let configPda: anchor.web3.PublicKey;
  let isaPda: anchor.web3.PublicKey;
  let vaultAta: anchor.web3.PublicKey;
  let investorStakePda: anchor.web3.PublicKey;
  let investor2StakePda: anchor.web3.PublicKey; // <-- Его стейк PDA

  const courseCost = new anchor.BN(15000000); // 10 токенов
  const percent = 10;
  const maxCap = new anchor.BN(50000000); // 15 токенов
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
    } catch (e) {
      console.warn("WARN: Investor AirDrop failed.");
    }

    try {
      console.log("\n-> 1.8. Requesting 5 SOL for Investor 2 (Payer for Stake)");
      const signature = await provider.connection.requestAirdrop(investor2.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(signature, 'confirmed');
      console.log("Investor 2 Airdrop confirmed.");
    } catch (e) {
      console.warn("WARN: Investor 2 AirDrop failed.");
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

    investor2Ata = await createAssociatedTokenAccount(
      provider.connection,
      admin.payer,
      mint,
      investor2.publicKey
    );
    console.log(`Investor 2 ATA: ${investor2Ata.toBase58()}`);

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
    await mintTo(provider.connection, admin.payer, mint, investor2Ata, admin.publicKey, 10000000); // 10 токенов
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
    [investor2StakePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), isaPda.toBuffer(), investor2.publicKey.toBuffer()],
      program.programId
    );
    console.log(`Investor 2 Stake PDA: ${investor2StakePda.toBase58()}`);

    console.log(`======================================================`);
  });


  it("Initialize Config", async () => {
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


  describe("Delinquency and Repayment Logic", () => {
    let expectedPayment: number;

    before(async () => {
      // Рассчитываем сумму платежа, которая должна быть внесена для исправления
      expectedPayment = salaryAmount.toNumber() * (percent / 100);


      console.log("\n-> 10.0. Oracle updates salary again (Basis for Delinquency)");
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
      assert.equal(isaAccount.status, 2, "ISA status should be Working (2) after salary update.");
    });

    it("10.1. Oracle successfully reports delinquency when payment is missing", async () => {
      // Проверка: Оракул (доверенное лицо) вызывает инструкцию
      await program.methods
        .reportDelinquency()
        .accounts({
          isaState: isaPda,
          config: configPda,
          oracle: oracle.publicKey,
        } as any)
        .signers([oracle])
        .rpc();

      // Проверяем статус ISA
      const isaAccount = await program.account.isaState.fetch(isaPda);
      assert.equal(isaAccount.status, 3, "Статус ISA должен быть 'Delinquent' (3)");
      console.log(`\t ISA Status: ${isaAccount.status} (Delinquent)`);
    });

    it("10.2. Fails if unauthorized account (e.g., Student) tries to report delinquency", async () => {
      // Попытка вызвать от имени студента. Должна упасть с ошибкой UnauthorizedOracle.
      try {
        await program.methods
          .reportDelinquency()
          .accounts({
            isaState: isaPda,
            config: configPda,
            oracle: student.publicKey, // Студент пытается подписать как "Оракул"
          } as any)
          .signers([student])
          .rpc();

        assert.fail("Транзакция не должна была пройти, т.к. подписана не Оракулом.");
      } catch (e) {
        const error = anchor.AnchorError.parse(e.logs);
        assert.equal(error.error.errorCode.code, "UnauthorizedOracle", "Ожидалась ошибка UnauthorizedOracle.");
      }
    });

    it("10.3. Student pays share while delinquent, clearing the status", async () => {
      // Проверяем баланс студента перед оплатой
      const initialStudentBalance = (await getAccount(provider.connection, studentAta)).amount;

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

      // Проверяем, что студент заплатил (это вторая выплата)
      const isaAccount = await program.account.isaState.fetch(isaPda);

      // alreadyPaid должен быть равен двум ожидаемым платежам (предыдущий + текущий)
      const totalPaid = expectedPayment + expectedPayment;

      assert.equal(isaAccount.alreadyPaid.toNumber(), totalPaid, "Total Paid не соответствует двум платежам.");

      // САМОЕ ВАЖНОЕ: Проверяем, что статус вернулся в Working (2)
      assert.equal(isaAccount.status, 2, "Статус ISA должен вернуться к 'Working' (2)");

      const finalStudentBalance = (await getAccount(provider.connection, studentAta)).amount;
      const diff = Number(initialStudentBalance) - Number(finalStudentBalance);
      assert.equal(diff, expectedPayment, "Студент должен был заплатить ровно одну долю.");

      console.log(`\t ISA Status reset to: ${isaAccount.status} (Working)`);
    });
  });
  describe("Dropout and Termination Logic", () => {
    // 1. Убедимся, что ISA был проинициализирован и оплачен ранее.

    console.log("\n-> 9.0. Dropout and Termination Logic");

    it("9.1. Fails if called by unauthorized account (e.g., Student)", async () => {
      // Попытка вызвать `report_dropout` от имени студента. Должна упасть с ошибкой UnauthorizedUniversity.
      try {
        await program.methods
          .reportDropout()
          .accounts({
            isaState: isaPda,
            config: configPda,
            university: student.publicKey, // Студент пытается подписать как "Университет"
          } as any)
          .signers([student])
          .rpc();

        // Если транзакция прошла, это ошибка теста
        assert.fail("Транзакция не должна была пройти, т.к. подписана не Университетом.");
      } catch (e) {
        // Проверяем, что ошибка — именно ошибка несанкционированного доступа
        const error = anchor.AnchorError.parse(e.logs);
        assert.equal(error.error.errorCode.code, "UnauthorizedUniversity");
      }
    });

    it("9.2. University successfully reports dropout and terminates ISA", async () => {
      const universitySigner = university;

      await program.methods
        .reportDropout()
        .accounts({
          isaState: isaPda,
          config: configPda,
          university: universitySigner.publicKey,
        } as any)
        .signers([universitySigner])
        .rpc();

      // Проверяем состояние ISA после исключения
      const isaAccount = await program.account.isaState.fetch(isaPda);

      // 1. Проверяем статус: Должен быть DroppedOut (4)
      assert.equal(isaAccount.status, 4, "Статус ISA должен быть 'DroppedOut' (4)");

      // 2. Проверяем обнуление обязательств
      assert.equal(isaAccount.maxCap.toNumber(), 0, "Max Cap должен быть обнулен (0)");
      assert.equal(isaAccount.percent, 0, "Процент оплаты должен быть обнулен (0)");

      console.log(`\t ISA Status: ${isaAccount.status}, Max Cap: ${isaAccount.maxCap.toNumber()}`);
    });

    it("9.3. Fails if Student tries to Pay Share after termination", async () => {
      // Проверяем, что платежи заблокированы.
      try {
        await program.methods
          .payShare()
          .accounts({
            isaState: isaPda,
            student: student.publicKey,
            studentAta: studentAta,
            vault: vaultAta,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          } as any)
          .signers([student])
          .rpc();

        assert.fail("Транзакция Pay Share не должна была пройти после исключения.");
      } catch (e) {
        // Ошибка должна быть либо InvalidStatus, либо NothingToPay (из-за max_cap=0)
        const error = anchor.AnchorError.parse(e.logs);
        // Если вы добавили проверку статуса в payShare, ожидайте InvalidStatus.
        // Если нет, NothingToPay сработает из-за max_cap = 0.
        const expectedErrors = ["InvalidStatus", "NothingToPay"];
        assert.include(expectedErrors, error.error.errorCode.code, "Ожидаемая ошибка блокировки платежа.");
      }
    });
  });
  it("Distribute Payments to Investors", async () => { /* ... (прошел успешно) */ });

  // describe("Multi-Investor Logic", () => {
  //   let initialVaultBalance = new anchor.BN(0);
  //   const totalInvestment = investAmount.toNumber() + investAmount2.toNumber(); // 15,000,000

  //   it("11.1. Investor 2 invests smaller amount", async () => {
  //     // Предполагается, что Investor 1 уже инвестировал в тесте 4.
  //     // Здесь нам нужно повторить инвестицию, если вы закомментировали старый тест 4.

  //     // --- 1. Повторяем инвестицию Инвестора 1 (если закомментирован старый тест 4)
  //     try {
  //       await program.methods
  //         .invest(investAmount) // 10,000,000
  //         .accounts({
  //           isaState: isaPda,
  //           investorStake: investorStakePda,
  //           investor: investor.publicKey,
  //           investorAta: investorAta,
  //           vault: vaultAta,
  //           systemProgram: anchor.web3.SystemProgram.programId,
  //           tokenProgram: TOKEN_PROGRAM_ID,
  //           associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  //           rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  //         } as any)
  //         .signers([investor])
  //         .rpc();
  //     } catch (e) {
  //       // Если тест 4 не закомментирован, эта транзакция упадет,
  //       // что является нормальным, если вы не позволяете повторные ставки.
  //       // Но для чистоты теста лучше работать с чистым ISA.
  //     }

  //     // --- 2. Инвестиция Инвестора 2
  //     await program.methods
  //       .invest(investAmount2) // 5,000,000
  //       .accounts({
  //         isaState: isaPda,
  //         investorStake: investor2StakePda, // PDA для Investor 2
  //         investor: investor2.publicKey,
  //         investorAta: investor2Ata,
  //         vault: vaultAta,
  //         systemProgram: anchor.web3.SystemProgram.programId,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //         associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  //         rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  //       } as any)
  //       .signers([investor2])
  //       .rpc();

  //     const isaAccount = await program.account.isaState.fetch(isaPda);
  //     const vaultInfo = await getAccount(provider.connection, vaultAta);
  //     initialVaultBalance = new anchor.BN(vaultInfo.amount.toString());

  //     assert.equal(isaAccount.totalInvested.toNumber(), totalInvestment, "Общая инвестированная сумма должна быть 15 токенов.");

  //     // Проверяем доли (процент от общего Invested):
  //     const stake1 = await program.account.investorStake.fetch(investorStakePda);
  //     const stake2 = await program.account.investorStake.fetch(investor2StakePda);

  //     // Stake 1: 10M / 15M = 66.67% (Примерно)
  //     assert.equal(stake1.amount.toNumber(), investAmount.toNumber(), "Доля Инвестора 1 должна быть 10M.");
  //     // Stake 2: 5M / 15M = 33.33%
  //     assert.equal(stake2.amount.toNumber(), investAmount2.toNumber(), "Доля Инвестора 2 должна быть 5M.");
  //   });

  //   it("11.2. Release Funds to University (using total investment)", async () => {
  //     await program.methods
  //       .releaseFundsToUniversity()
  //       .accounts({
  //         isaState: isaPda,
  //         vault: vaultAta,
  //         config: configPda,
  //         universityAta: universityAta,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //       } as any)
  //       .rpc();

  //     const isaAccount = await program.account.isaState.fetch(isaPda);
  //     assert.equal(isaAccount.status, 1, "Статус должен быть StudyingPaid (1)");

  //     await program.methods
  //       .updateSalary(salaryAmount)
  //       .accounts({
  //         isaState: isaPda,
  //         config: configPda,
  //         oracle: oracle.publicKey, // Используйте oracle
  //       } as any)
  //       .signers([oracle])
  //       .rpc();

  //     // Проверка, что статус изменился на Working (2)
  //     const updatedIsaAccount = await program.account.isaState.fetch(isaPda);
  //     assert.equal(updatedIsaAccount.status, 2, "Статус должен быть Working (2) после UpdateSalary");
  //     const vaultInfo = await getAccount(provider.connection, vaultAta);
  //     assert.equal(Number(vaultInfo.amount), 0, "Сейф должен быть пуст.");

  //     const uniInfo = await getAccount(provider.connection, universityAta);
  //     // Университет получает 10M, так как courseCost = 10M.
  //     // Если courseCost был 15M, то uniInfo.amount = totalInvestment.

  //     // Если courseCost = 10M:
  //     // assert.equal(Number(uniInfo.amount), courseCost.toNumber(), "Университет получает только Course Cost.");

  //     // Если courseCost >= 15M (для этого теста):
  //     assert.equal(Number(uniInfo.amount), totalInvestment, "Университет получает всю сумму инвестиций.");
  //   });


  //   it("11.3. Student Pays Share (creating funds for distribution)", async () => {
  //     // Предполагается, что Update Salary был вызван ранее.
  //     const expectedPayment = salaryAmount.toNumber() * (percent / 100); // 5M

  //     // Обновим баланс студента, если он истратил его в предыдущих тестах:
  //     // await mintTo(provider.connection, admin.payer, mint, studentAta, admin.publicKey, 10000000); 

  //     await program.methods
  //       .payShare()
  //       .accounts({
  //         isaState: isaPda,
  //         student: student.publicKey,
  //         studentAta: studentAta,
  //         vault: vaultAta,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //       } as any)
  //       .signers([student])
  //       .rpc();

  //     const vaultInfo = await getAccount(provider.connection, vaultAta);
  //     assert.equal(Number(vaultInfo.amount), expectedPayment, "В хранилище должна быть сумма платежа (5M).");
  //   });

  //   it("11.4. Distribute Payments correctly splits funds between two investors", async () => {
  //     const amountToDistribute = 5000000; // 5M (вся сумма в хранилище)

  //     // Ожидаемые доли:
  //     const investor1Share = (amountToDistribute * 10) / 15; // 3,333,333
  //     const investor2Share = (amountToDistribute * 5) / 15;  // 1,666,666

  //     // Балансы перед распределением
  //     const initialInvestor1Balance = (await getAccount(provider.connection, investorAta)).amount;
  //     const initialInvestor2Balance = (await getAccount(provider.connection, investor2Ata)).amount;

  //     await program.methods
  //       .distributePayments(new anchor.BN(amountToDistribute))
  //       .accounts({
  //         isaState: isaPda,
  //         vault: vaultAta,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //       } as any)
  //       .remainingAccounts([
  //         // Инвестор 1 (10M доля)
  //         { pubkey: investorStakePda, isWritable: false, isSigner: false },
  //         { pubkey: investorAta, isWritable: true, isSigner: false },
  //         // Инвестор 2 (5M доля)
  //         { pubkey: investor2StakePda, isWritable: false, isSigner: false },
  //         { pubkey: investor2Ata, isWritable: true, isSigner: false },
  //       ])
  //       .rpc();

  //     // 1. Проверка баланса Инвестора 1
  //     const finalInvestor1Balance = (await getAccount(provider.connection, investorAta)).amount;
  //     const diff1 = Number(finalInvestor1Balance) - Number(initialInvestor1Balance);

  //     // 2. Проверка баланса Инвестора 2
  //     const finalInvestor2Balance = (await getAccount(provider.connection, investor2Ata)).amount;
  //     const diff2 = Number(finalInvestor2Balance) - Number(initialInvestor2Balance);

  //     // Проверка с допуском на округление (так как 10/15 и 5/15 — это бесконечные дроби)
  //     const totalDiff = diff1 + diff2;
  //     assert.closeTo(totalDiff, amountToDistribute, 1, "Общая распределенная сумма должна быть 5M.");

  //     assert.closeTo(diff1, investor1Share, 1, "Инвестор 1 получил некорректную долю.");
  //     assert.closeTo(diff2, investor2Share, 1, "Инвестор 2 получил некорректную долю.");

  //     console.log(`\t✅ Investor 1 received: ${diff1.toLocaleString()} (Expected: ${Math.round(investor1Share).toLocaleString()})`);
  //     console.log(`\t✅ Investor 2 received: ${diff2.toLocaleString()} (Expected: ${Math.round(investor2Share).toLocaleString()})`);
  //   });
  // });
});