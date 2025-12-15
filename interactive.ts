import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { 
    createMint, 
    createAssociatedTokenAccount, 
    mintTo, 
    getAssociatedTokenAddress 
} from "@solana/spl-token";
import inquirer from "inquirer";
// Убедитесь, что путь к вашему ISAService корректен
import { ISAService } from "./backend/api"; 

// ----------------------------------------------------------------------
// 1. ГЛОБАЛЬНОЕ СОСТОЯНИЕ И КОНФИГУРАЦИЯ
// ----------------------------------------------------------------------
const RPC_URL = "http://127.0.0.1:8899";
const connection = new Connection(RPC_URL, "confirmed");
const DECIMALS = 1_000_000; // Для 6 знаков после запятой

const state = {
    mint: null as PublicKey | null,
    admin: Keypair.generate(),
    student: Keypair.generate(),
    investor: Keypair.generate(),
    university: Keypair.generate(),
    oracle: Keypair.generate(),
    services: {} as Record<string, ISAService>,
};

// ----------------------------------------------------------------------
// 2. АВТОМАТИЧЕСКАЯ ИНИЦИАЛИЗАЦИЯ (ИСПРАВЛЕНО)
// ----------------------------------------------------------------------
async function setupEnvironment() {
    console.log("\n🚀 Инициализация окружения...");

    // 1. Раздача SOL всем участникам
    const accounts = [state.admin, state.student, state.investor, state.university, state.oracle];
    const airDrops = accounts.map(acc => 
        connection.requestAirdrop(acc.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL)
    );
    await Promise.all(airDrops.map(async (sig) => connection.confirmTransaction(await sig)));

    // 2. Настройка провайдера
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(state.admin), {});
    anchor.setProvider(provider);
    
    // 3. Создание токена и ATA
    state.mint = await createMint(connection, state.admin, state.admin.publicKey, null, 6);
    
    // Создаем ATA для всех, кто будет работать с токенами
    const investorAta = await createAssociatedTokenAccount(connection, state.admin, state.mint, state.investor.publicKey);
    const studentAta = await createAssociatedTokenAccount(connection, state.admin, state.mint, state.student.publicKey);
    
    // ИСПРАВЛЕНИЕ: Создаем ATA для Университета, чтобы он мог принимать токены
    await createAssociatedTokenAccount(connection, state.admin, state.mint, state.university.publicKey);
    
    // Выдаем им по 100 токенов для тестов
    await mintTo(connection, state.admin, state.mint, investorAta, state.admin.publicKey, 100 * DECIMALS); 
    await mintTo(connection, state.admin, state.mint, studentAta, state.admin.publicKey, 100 * DECIMALS); 

    // 4. Инициализация сервисов для каждой роли
    state.services.admin = new ISAService(connection, new anchor.Wallet(state.admin));
    state.services.student = new ISAService(connection, new anchor.Wallet(state.student));
    state.services.investor = new ISAService(connection, new anchor.Wallet(state.investor));
    state.services.oracle = new ISAService(connection, new anchor.Wallet(state.oracle));
    state.services.university = new ISAService(connection, new anchor.Wallet(state.university));

    // 5. Первоначальная настройка контракта (Initialize Config)
    await state.services.admin.initializeConfig(state.oracle.publicKey, state.university.publicKey);
    
    console.log("✅ Среда готова! Токены начислены, конфиг создан.");
    console.log(`Студент: ${state.student.publicKey.toBase58().slice(0, 10)}...`);
    console.log(`Инвестор: ${state.investor.publicKey.toBase58().slice(0, 10)}...`);
}

// ----------------------------------------------------------------------
// 3. ГЛАВНОЕ МЕНЮ
// ----------------------------------------------------------------------
async function mainMenu() {
    const { role } = await inquirer.prompt([
        {
            type: "list",
            name: "role",
            message: "Выберите роль для выполнения действий:",
            choices: [
                { name: "🎓 СТУДЕНТ: Управление ISA и платежи", value: "student" },
                { name: "💰 ИНВЕСТОР: Вложения и доли", value: "investor" },
                { name: "⚖️ АДМИН: Выплаты и распределение", value: "admin" },
                { name: "🔮 ОРАКУЛ/ВУЗ: Статусы и зарплаты", value: "oracle" },
                { name: "🚪 ВЫХОД", value: "exit" }
            ]
        }
    ]);

    if (role === "exit") process.exit();

    try {
        if (role === "student") await studentMenu();
        if (role === "investor") await investorMenu();
        if (role === "admin") await adminMenu();
        if (role === "oracle") await oracleMenu();
    } catch (error: any) {
        // Улучшенная обработка ошибок для вывода логов
        console.error("\n❌ Ошибка выполнения:", error.message);
        if (error.logs) {
            console.error("   Logs:", error.logs.join("\n"));
        }
    }

    await mainMenu();
}

// ----------------------------------------------------------------------
// 4. ПОДМЕНЮ РОЛЕЙ
// ----------------------------------------------------------------------

async function studentMenu() {
    const { action } = await inquirer.prompt([{
        type: "list",
        name: "action",
        message: "Действия студента:",
        choices: ["Создать новую ISA", "Статус финансирования", "Выплатить долю (Pay Share)", "Назад"]
    }]);

    if (action === "Создать новую ISA") {
        const answers: any = await inquirer.prompt([
            { type: "input", name: "cost", message: "Стоимость обучения (токены):", default: "15" },
            { type: "input", name: "cap", message: "Max Cap (токены):", default: "50" },
            { type: "input", name: "percent", message: "Процент от дохода (0-100):", default: "10" }
        ]);
        
        const tx = await state.services.student.initializeIsa(
            state.mint!, 
            Number(answers.cost) * DECIMALS, 
            Number(answers.percent), 
            Number(answers.cap) * DECIMALS
        );
        console.log(`✅ ISA создана! TX: ${tx.slice(0, 20)}...`);
    }

    if (action === "Статус финансирования") {
        const status = await state.services.student.getFundingStatus(state.student.publicKey);
        
        // ИСПРАВЛЕНИЕ: Используем totalInvested и courseCost
        console.log(`\n--- СТАТУС ---`);
        console.log(`Собрано: ${status.totalInvested / DECIMALS} токенов`);
        console.log(`Цель (Course Cost): ${status.courseCost / DECIMALS} токенов`);
        console.log(`Нужно еще: ${status.remainingToInvest / DECIMALS} токенов`);
        console.log(`Завершено: ${status.isFullyFunded ? "ДА" : "НЕТ"}`);
    }

    if (action === "Выплатить долю (Pay Share)") {
        const tx = await state.services.student.payShare(state.student.publicKey, state.mint!);
        console.log(`✅ Платеж успешно отправлен! TX: ${tx.slice(0, 20)}...`);
    }
}

async function investorMenu() {
    const { action } = await inquirer.prompt([{
        type: "list",
        name: "action",
        message: "Действия инвестора:",
        choices: ["Инвестировать средства", "Посмотреть мои доли", "Назад"]
    }]);

    if (action === "Инвестировать средства") {
        const { amount }: any = await inquirer.prompt([
            { type: "input", name: "amount", message: "Сумма инвестиции (в токенах):" }
        ]);
        
        const tx = await state.services.investor.invest(
            state.student.publicKey, 
            Number(amount) * DECIMALS, 
            state.mint!
        );
        console.log(`✅ Инвестиция подтверждена! TX: ${tx.slice(0, 20)}...`);
    }

    if (action === "Посмотреть мои доли") {
        const stakes = await state.services.investor.getAllStakesForIsa(state.student.publicKey);
        
        // ИСПРАВЛЕНИЕ: Доступ к данным через .account
        console.table(stakes.map(s => ({
            Инвестор: s.account.investor.toBase58().slice(0, 8),
            Сумма: s.account.amount.toNumber() / DECIMALS
        })));
    }
}

async function adminMenu() {
    const { action } = await inquirer.prompt([{
        type: "list",
        name: "action",
        message: "Действия администратора:",
        choices: ["Выплатить ВУЗу (Release Funds)", "Распределить доходы инвесторам", "Назад"]
    }]);

    if (action === "Выплатить ВУЗу (Release Funds)") {
        // ATA для университета уже существует благодаря setupEnvironment
        const uniAta = await getAssociatedTokenAddress(state.mint!, state.university.publicKey);
        const tx = await state.services.admin.releaseFunds(state.student.publicKey, uniAta);
        console.log(`✅ Средства из хранилища переведены ВУЗу! TX: ${tx.slice(0, 20)}...`);
    }

    if (action === "Распределить доходы инвесторам") {
        const isa = await state.services.admin.getIsaState(state.student.publicKey);
        // Предполагаем, что эти поля (alreadyPaid и totalDistributed) существуют в стейте ISA
        const toDistribute = isa.alreadyPaid.toNumber() - isa.totalDistributed.toNumber();
        
        if (toDistribute <= 0) {
            console.log("Нет средств для распределения.");
            return;
        }

        const tx = await state.services.admin.distributePayments(state.student.publicKey, toDistribute, state.mint!);
        console.log(`✅ Распределено ${toDistribute / DECIMALS} токенов. TX: ${tx.slice(0, 20)}...`);
    }
}

async function oracleMenu() {
    const { action } = await inquirer.prompt([{
        type: "list",
        name: "action",
        message: "Действия Оракула / Университета:",
        choices: ["Обновить зарплату (Oracle)", "Сообщить о просрочке (Oracle)", "Отчислить студента (University)", "Назад"]
    }]);

    if (action === "Обновить зарплату (Oracle)") {
        const { sal }: any = await inquirer.prompt([{ type: "input", name: "sal", message: "Зарплата студента (токены):" }]);
        const tx = await state.services.oracle.updateSalary(state.student.publicKey, Number(sal) * DECIMALS);
        console.log(`✅ Данные о доходе обновлены. TX: ${tx.slice(0, 20)}...`);
    }

    if (action === "Сообщить о просрочке (Oracle)") {
        const tx = await state.services.oracle.reportDelinquency(state.student.publicKey);
        console.log(`⚠️ Статус просрочки установлен. TX: ${tx.slice(0, 20)}...`);
    }

    if (action === "Отчислить студента (University)") {
        const tx = await state.services.university.reportDropout(state.student.publicKey);
        console.log(`🚫 Студент отчислен. Обязательства аннулированы. TX: ${tx.slice(0, 20)}...`);
    }
}

// ----------------------------------------------------------------------
// 5. ЗАПУСК
// ----------------------------------------------------------------------
(async () => {
    try {
        await setupEnvironment();
        await mainMenu();
    } catch (e) {
        console.error("Критическая ошибка:", e);
    }
})();