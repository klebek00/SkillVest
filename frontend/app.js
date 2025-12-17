import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { createMint, createAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ISAService } from "../backend/api";

// --- 1. Глобальная настройка ---
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const DECIMALS = 1_000_000;

// Расширенный список ролей с двумя инвесторами
const roles = {
    student: Keypair.generate(),
    investor1: Keypair.generate(),
    investor2: Keypair.generate(),
    university: Keypair.generate(),
    oracle: Keypair.generate(),
    admin: Keypair.generate(),
};

// Вспомогательная функция для создания кошелька
const createWallet = (keypair) => ({ publicKey: keypair.publicKey, signTransaction: async (tx) => { tx.sign(keypair); return tx; }, signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign(keypair)); return txs; } });

// Расширенный список сервисов для каждой роли
const services = {
    student: new ISAService(connection, createWallet(roles.student)),
    investor1: new ISAService(connection, createWallet(roles.investor1)),
    investor2: new ISAService(connection, createWallet(roles.investor2)),
    university: new ISAService(connection, createWallet(roles.university)),
    oracle: new ISAService(connection, createWallet(roles.oracle)),
    admin: new ISAService(connection, createWallet(roles.admin)),
};

let mint = null;
let appState = { isa: null, stakes: [], time: 0, eventLog: [], platformConfig: {}, activeInvestor: 'investor1' };

function handleError(error, userMessage) {
    console.error("Техническая ошибка:", error);
    alert(`❌ ${userMessage}\n\n(Подробности смотрите в консоли F12)`);
}

// --- 2. Логика обновления UI, таймлайна и событий ---
const STATUS_MAP = { 0: { text: "Сбор средств", class: "status-0" }, 1: { text: "Обучение оплачено", class: "status-1" }, 2: { text: "Трудоустроен", class: "status-2" }, 3: { text: "Просрочка", class: "status-3" }, 4: { text: "Отчислен", class: "status-4" }, 5: { text: "Контракт выполнен", class: "status-5" }, 6: { text: "Безработный", class: "status-6" } };

function addEvent(icon, title, description) {
    appState.eventLog.unshift({ time: appState.time, icon, title, description });
}

function renderTimeline(elementId, log) {
    const container = document.getElementById(elementId);
    if (!container) return;
    container.innerHTML = log.map(event => `<div class="timeline-item"><div class="timeline-icon">${event.icon}</div><div class="timeline-content"><strong>${event.title}</strong><span>Месяц ${event.time}: ${event.description}</span></div></div>`).join('') || '<span>Событий пока нет...</span>';
}

async function updateUIState() {
    if (!mint) {
        document.getElementById('student-isa-creation').style.display = 'block';
        document.getElementById('student-isa-dashboard').style.display = 'none';
        return;
    }
    try {
        const isa = await services.student.getIsaState(roles.student.publicKey);
        const stakes = await services.student.getAllStakesForIsa(roles.student.publicKey);
        appState.isa = isa; appState.stakes = stakes;

        const { status, totalInvested, courseCost, lastSalary, percent, alreadyPaid, maxCap, totalDistributed } = {
            status: isa.status, totalInvested: isa.totalInvested.toNumber(), courseCost: isa.courseCost.toNumber(), lastSalary: isa.lastSalary.toNumber(), percent: isa.percent, alreadyPaid: isa.alreadyPaid.toNumber(), maxCap: isa.maxCap.toNumber(), totalDistributed: isa.totalDistributed.toNumber(),
        };

        const statusInfo = STATUS_MAP[status] || { text: 'Неизвестно', class: '' };
        const requiredPayment = lastSalary * (percent / 100);
        const isFullyFunded = totalInvested >= courseCost;
        const isTerminated = status === 4 || status === 5;

        // --- Обновление вкладки Студента ---
        document.getElementById('student-isa-creation').style.display = 'none';
        document.getElementById('student-isa-dashboard').style.display = 'block';
        document.getElementById('student-id').textContent = roles.student.publicKey.toBase58().substring(0, 12) + '...';
        document.getElementById('student-university-id').textContent = appState.platformConfig.university.toBase58().substring(0, 12) + '...';
        document.getElementById('student-status').textContent = statusInfo.text;
        document.getElementById('student-salary').textContent = `${lastSalary / DECIMALS} токенов`;
        document.getElementById('student-payment-due').textContent = `${(requiredPayment / DECIMALS).toFixed(2)} токенов`;
        document.getElementById('student-total-paid').textContent = `${alreadyPaid / DECIMALS} токенов`;
        document.getElementById('student-funding-progress').style.width = `${courseCost > 0 ? (totalInvested / courseCost) * 100 : 0}%`;
        document.getElementById('student-funded').textContent = `${totalInvested / DECIMALS} / ${courseCost / DECIMALS}`;
        document.getElementById('student-repayment-progress').style.width = `${maxCap > 0 ? (alreadyPaid / maxCap) * 100 : 0}%`;
        document.getElementById('student-repaid-cap').textContent = `${alreadyPaid / DECIMALS} / ${maxCap / DECIMALS}`;
        document.getElementById('pay-share-btn').disabled = (status !== 2 && status !== 3) || isTerminated;

        // --- Обновление вкладки Инвестора ---
        const activeInvestorKeypair = roles[appState.activeInvestor];
        document.getElementById('investor-id-display').textContent = `Ваш ID: ...${activeInvestorKeypair.publicKey.toBase58().slice(-8)}`;
        document.getElementById('investor-status').textContent = statusInfo.text;
        document.getElementById('investor-goal').textContent = `${courseCost / DECIMALS} токенов`;
        document.getElementById('funding-progress').style.width = `${courseCost > 0 ? (totalInvested / courseCost) * 100 : 0}%`;
        document.getElementById('investor-funded').textContent = `${totalInvested / DECIMALS} / ${courseCost / DECIMALS} токенов`;
        
        const myStakeInfo = stakes.find(s => s.account.investor.equals(activeInvestorKeypair.publicKey));
        const myStakeAmount = myStakeInfo ? myStakeInfo.account.amount.toNumber() : 0;
        let myRepayment = 0, myMaxReturn = 0;
        if (myStakeAmount > 0 && totalInvested > 0) {
            const myShare = myStakeAmount / totalInvested;
            myRepayment = totalDistributed * myShare;
            myMaxReturn = maxCap * myShare;
        }
        const roi = myStakeAmount > 0 ? (myRepayment / myStakeAmount) * 100 : 0;
        document.getElementById('investor-my-stake').textContent = `${myStakeAmount / DECIMALS} токенов`;
        document.getElementById('investor-repaid').textContent = `${(myRepayment / DECIMALS).toFixed(2)} токенов`;
        document.getElementById('investor-max-return').textContent = `${(myMaxReturn / DECIMALS).toFixed(2)} токенов`;
        document.getElementById('investor-roi').textContent = `${roi.toFixed(1)}%`;
        document.getElementById('repayment-progress').style.width = `${myMaxReturn > 0 ? (myRepayment / myMaxReturn) * 100 : 0}%`;
        document.getElementById('invest-btn').disabled = isFullyFunded || isTerminated;
        document.getElementById('invest-amount').disabled = isFullyFunded || isTerminated;

        document.getElementById('all-investors-table').getElementsByTagName('tbody')[0].innerHTML = stakes.map(stake => `
            <tr>
                <td><code>...${stake.account.investor.toBase58().slice(-8)}</code></td>
                <td>${stake.account.amount.toNumber() / DECIMALS} токенов</td>
                <td>${totalInvested > 0 ? ((stake.account.amount.toNumber() / totalInvested) * 100).toFixed(1) : 0}%</td>
            </tr>
        `).join('');

        // --- Обновление вкладки Доверенных Ролей ---
        const availableToDistribute = alreadyPaid - totalDistributed;
        document.getElementById('admin-distribute-amount').textContent = `${(availableToDistribute / DECIMALS).toFixed(2)} токенов`;
        document.getElementById('distribute-btn').disabled = availableToDistribute <= 0 || isTerminated;
        document.getElementById('release-funds-btn').disabled = status !== 0 || !isFullyFunded || isTerminated;
        document.getElementById('update-salary-btn').disabled = isTerminated;
        document.getElementById('report-dropout-btn').disabled = isTerminated;
        document.getElementById('report-delinquency-btn').disabled = status !== 2 || isTerminated;
        
        renderTimeline('student-timeline', appState.eventLog);
        
        document.getElementById('stats-total-invested').textContent = `${totalInvested / DECIMALS} токенов`;
        document.getElementById('stats-active-isa').textContent = (status < 4 && mint) ? '1' : '0';
        document.getElementById('stats-current-month').textContent = `Месяц ${appState.time}`;

    } catch (e) { console.warn("Не удалось обновить UI:", e); }
}

function setupEventListeners() {
    // Навигация
    document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
        document.querySelectorAll('nav button').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        const viewId = button.id.replace('nav-', '') + '-view';
        document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
    }));

    // Переключатель инвесторов
    document.querySelectorAll('.investor-switch-btn').forEach(button => {
        button.addEventListener('click', () => {
            appState.activeInvestor = button.dataset.investor;
            document.querySelectorAll('.investor-switch-btn').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            alert(`Вы переключились на Инвестора #${button.dataset.investor.slice(-1)}`);
            updateUIState();
        });
    });

    // Действия
    document.getElementById('create-isa-btn').addEventListener('click', async () => {
        try {
            mint = await createMint(connection, roles.admin, roles.admin.publicKey, null, 6);
            await Promise.all([
                createAssociatedTokenAccount(connection, roles.student, mint, roles.student.publicKey),
                createAssociatedTokenAccount(connection, roles.investor1, mint, roles.investor1.publicKey).then(ata => mintTo(connection, roles.admin, mint, ata, roles.admin.publicKey, 100 * DECIMALS)),
                createAssociatedTokenAccount(connection, roles.investor2, mint, roles.investor2.publicKey).then(ata => mintTo(connection, roles.admin, mint, ata, roles.admin.publicKey, 100 * DECIMALS)),
                createAssociatedTokenAccount(connection, roles.university, mint, roles.university.publicKey)
            ]);
            await services.student.initializeIsa(mint, 15 * DECIMALS, 10, 50 * DECIMALS);
            addEvent('', 'ISA создан', `Контракт инициирован с целью сбора ${15} токенов.`);
            await updateUIState();
        } catch(e) { handleError(e, "Не удалось создать ISA."); }
    });

    document.getElementById('invest-btn').addEventListener('click', async () => {
        const amount = document.getElementById('invest-amount').value;
        const activeInvestorService = services[appState.activeInvestor];
        try {
            await activeInvestorService.invest(roles.student.publicKey, Number(amount) * DECIMALS, mint);
            addEvent('', `Инвестиция от Инвестора #${appState.activeInvestor.slice(-1)}`, `Вложено ${amount} токенов.`);
            await updateUIState();
        } catch(e) { handleError(e, "Не удалось инвестировать."); }
    });
    
    document.getElementById('simulate-month-btn').addEventListener('click', () => {
        appState.time++;
        alert(`▶ Время промотано вперед. Наступил Месяц ${appState.time}.`);
        addEvent('', 'Прошел месяц', `Наступил новый период.`);
        updateUIState();
    });
    
    document.getElementById('pay-share-btn').addEventListener('click', async () => {
        try {
            const studentAta = getAssociatedTokenAddressSync(mint, roles.student.publicKey);
            await mintTo(connection, roles.admin, mint, studentAta, roles.admin.publicKey, 5000 * DECIMALS);
            const paymentAmount = (appState.isa.lastSalary.toNumber() / DECIMALS) * (appState.isa.percent / 100);
            await services.student.payShare(roles.student.publicKey, mint);
            addEvent('', 'Платеж внесен', `Студент выплатил ${paymentAmount.toFixed(2)} токенов.`);
            await updateUIState();
        } catch(e) { handleError(e, "Ошибка выплаты доли."); }
    });

    document.getElementById('release-funds-btn').addEventListener('click', async () => {
        try {
            const universityAta = getAssociatedTokenAddressSync(mint, roles.university.publicKey);
            await services.admin.releaseFunds(roles.student.publicKey, universityAta);
            addEvent('', 'Средства переведены', `Собранные средства отправлены в университет.`);
            await updateUIState();
        } catch(e) { handleError(e, "Ошибка перевода средств."); }
    });

    document.getElementById('update-salary-btn').addEventListener('click', async () => {
        const salary = document.getElementById('salary-amount').value;
        if (!salary) { alert("Введите сумму зарплаты!"); return; }
        try {
            await services.oracle.updateSalary(roles.student.publicKey, Number(salary) * DECIMALS);
            addEvent('', 'Зарплата обновлена', `Оракул установил доход в размере ${salary} токенов.`);
            await updateUIState();
        } catch(e) { handleError(e, "Ошибка обновления зарплаты."); }
    });
    
    document.getElementById('distribute-btn').addEventListener('click', async () => {
        try {
            const toDistribute = appState.isa.alreadyPaid.toNumber() - appState.isa.totalDistributed.toNumber();
            await services.admin.distributePayments(roles.student.publicKey, toDistribute, mint);
            addEvent('', 'Выплаты распределены', `${(toDistribute / DECIMALS).toFixed(2)} токенов отправлены инвесторам.`);
            await updateUIState();
        } catch(e) { handleError(e, "Ошибка распределения средств."); }
    });
    
    document.getElementById('report-dropout-btn').addEventListener('click', async () => {
        if (!confirm("Вы уверены? Это действие необратимо.")) return;
        try {
            await services.university.reportDropout(roles.student.publicKey);
            addEvent('', 'Студент отчислен', `Университет аннулировал контракт ISA.`);
            await updateUIState();
        } catch(e) { handleError(e, "Не удалось сообщить об отчислении."); }
    });
    
    document.getElementById('report-delinquency-btn').addEventListener('click', async () => {
        try {
            await services.oracle.reportDelinquency(roles.student.publicKey);
            addEvent('', 'Зафиксирована просрочка', `Оракул сообщил о пропущенном платеже.`);
            await updateUIState();
        } catch(e) { handleError(e, "Не удалось сообщить о просрочке."); }
    });
}

async function main() {
    const investorViewHTML = `<div class="card"><h2>Переключение профиля</h2><p id="investor-id-display" style="color: var(--text-secondary);"></p><div class="action-group"><button class="investor-switch-btn active" data-investor="investor1">Инвестор #1</button><button class="investor-switch-btn" data-investor="investor2">Инвестор #2</button></div></div><div class="card"><h2>Общий статус ISA</h2><div class="info-grid"><div class="info-item"><strong>СТАТУС</strong><span id="investor-status">Ожидание</span></div><div class="info-item"><strong>ЦЕЛЬ СБОРА</strong><span id="investor-goal">0 токенов</span></div></div><strong>Прогресс сбора средств</strong><div class="progress-bar" style="margin-top: 5px;"><div id="funding-progress" class="progress-bar-inner"></div></div><div id="investor-funded" class="progress-label"></div></div><div class="card"><h2>Ваш финансовый дашборд</h2><div class="info-grid"><div class="info-item"><strong>Вы инвестировали</strong><span id="investor-my-stake">0 токенов</span></div><div class="info-item"><strong>Вам возвращено</strong><span id="investor-repaid">0 токенов</span></div><div class="info-item"><strong>Потенциальный доход</strong><span id="investor-max-return">0 токенов</span></div><div class="info-item"><strong>ROI</strong><span id="investor-roi">0%</span></div></div><strong>Прогресс возврата инвестиций</strong><div class="progress-bar" style="margin-top: 5px;"><div id="repayment-progress" class="progress-bar-inner"></div></div></div><div class="card"><h2>Инвестировать в ISA</h2><div class="action-group"><input type="number" id="invest-amount" value="10" style="width: 150px;"><button id="invest-btn">Инвестировать</button></div></div><div class="card"><h2>Все инвесторы этого ISA</h2><table id="all-investors-table"><thead><tr><th>Инвестор (ID)</th><th>Сумма вклада</th><th>Доля в пуле</th></tr></thead><tbody></tbody></table></div>`;
    document.getElementById('investor-view').innerHTML = investorViewHTML;
    
    console.log("Инициализация окружения...");
    try {
        const airdropPromises = Object.values(roles).map(user => connection.requestAirdrop(user.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL));
        await Promise.all(airdropPromises.map(p => p.then(sig => connection.confirmTransaction(sig, 'confirmed'))));
        console.log(" Все участники получили SOL.");

        await services.admin.initializeConfig(roles.oracle.publicKey, roles.university.publicKey);
        appState.platformConfig = { university: roles.university.publicKey, oracle: roles.oracle.publicKey, admin: roles.admin.publicKey };
        console.log(" Глобальный конфиг инициализирован.");
        
        document.getElementById('role-university-id').textContent = roles.university.publicKey.toBase58();
        document.getElementById('role-oracle-id').textContent = roles.oracle.publicKey.toBase58();
        document.getElementById('role-admin-id').textContent = roles.admin.publicKey.toBase58();
        
        addEvent('✨', 'Платформа запущена', 'Все системы готовы к работе.');

    } catch (e) { handleError(e, "Критическая ошибка инициализации."); }
    
    setupEventListeners();
    await updateUIState();
}

document.addEventListener('DOMContentLoaded', main);