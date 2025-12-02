// programs/isa_contract/src/lib.rs
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("E9kqJYGA1fXhVqdE8eLYy2C98FD4Bv44Nud5aiNtjwJA");

#[program]
pub mod isa_contract {
    use super::*;

    /// Initialize ISA account.
    /// Expected flow:
    /// 1) Client computes ISA PDA: seeds = [b"isa", student_pubkey]
    /// 2) Client creates associated token account (ATA) for ISA PDA (vault) for chosen mint
    /// 3) Client calls this instruction passing the already-created vault ATA
    pub fn initialize_isa(
        ctx: Context<InitializeIsa>,
        course_cost: u64,
        percent: u8,
        max_cap: u64,
    ) -> Result<()> {
        require!(percent > 0 && percent <= 100, IsaError::InvalidPercent);
        let isa = &mut ctx.accounts.isa_state;

        isa.owner = ctx.accounts.student.key();
        isa.token_mint = ctx.accounts.mint.key();
        isa.vault = ctx.accounts.vault.key();
        isa.course_cost = course_cost;
        isa.percent = percent;
        isa.max_cap = max_cap;
        isa.total_invested = 0;
        isa.already_paid = 0;
        isa.total_distributed = 0;
        isa.last_salary = 0;
        isa.status = IsaStatus::Learning as u8;
        isa.bump = ctx.bumps.isa_state;

        // Sanity checks: vault must be ATA for ISA PDA and have correct mint
        require!(ctx.accounts.vault.mint == isa.token_mint, IsaError::InvalidVault);
        // Note: we cannot easily check that vault.owner == isa_pda before isa_state is created,
        // but client should create vault ATA for the ISA PDA (derived using same seeds). Here we verify owner matches expected PDA:
        let expected_isa_pda = ctx.accounts.isa_state.key(); // Получаем Pubkey ISA PDA
        require!(ctx.accounts.vault.owner == expected_isa_pda, IsaError::InvalidVaultOwner);

        Ok(())
    }

    /// Invest SPL tokens into ISA vault.
    /// Investor must pass investor_ata and investor_signer.
    pub fn invest(ctx: Context<Invest>, amount: u64) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        require!(isa.status == IsaStatus::Learning as u8, IsaError::InvalidStatus);
        require!(amount > 0, IsaError::InvalidAmount);

        // Check max cap wrt course cost or max_cap if you want limit on investments
        // Here we limit total_invested to course_cost (cannot overfund), or to some safety bound.
        if isa.total_invested.checked_add(amount).ok_or(IsaError::MathOverflow)? > isa.course_cost {
            return err!(IsaError::FundingExceedsCourseCost);
        }

        // Transfer SPL from investor ATA -> vault ATA
        let cpi_accounts = Transfer {
            from: ctx.accounts.investor_ata.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update ISA totals
        isa.total_invested = isa.total_invested.checked_add(amount).ok_or(IsaError::MathOverflow)?;

        // Update or init investor stake PDA
        let stake = &mut ctx.accounts.investor_stake;
        if !stake.initialized {
            stake.isa = isa.key();
            stake.investor = ctx.accounts.investor.key();
            stake.amount = amount;
            stake.initialized = true;
            stake.bump = ctx.bumps.investor_stake;
        } else {
            // safety: ensure stake belongs to this ISA and investor
            require!(stake.isa == isa.key(), IsaError::InvalidStake);
            require!(stake.investor == ctx.accounts.investor.key(), IsaError::InvalidStakeOwner);
            stake.amount = stake.amount.checked_add(amount).ok_or(IsaError::MathOverflow)?;
        }

        Ok(())
    }

    /// Release funds from vault to university ATA (called once when funds should be paid to the school)
    pub fn release_funds_to_university(ctx: Context<ReleaseFunds>) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        require!(isa.status == IsaStatus::Learning as u8, IsaError::InvalidStatus);

        let vault_balance = ctx.accounts.vault.amount;
        require!(vault_balance > 0, IsaError::NoFunds);

        // Signer seeds for ISA PDA
        let isa_seeds = &[b"isa", isa.owner.as_ref(), &[isa.bump]];
        let signer = &[&isa_seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.university_ata.to_account_info(),
            authority: isa.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer);
        token::transfer(cpi_ctx, vault_balance)?;

        isa.status = IsaStatus::StudyingPaid as u8;
        Ok(())
    }

    /// Oracle updates salary (must be an authorized oracle in production)
    pub fn update_salary(ctx: Context<UpdateSalary>, salary: u64) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        isa.last_salary = salary;
        isa.status = if salary == 0 { IsaStatus::Unemployed as u8 } else { IsaStatus::Working as u8 };
        Ok(())
    }

    /// Student pays their share (transfers tokens from student_ata -> vault).
    /// The contract caps payments so total does not exceed max_cap.
    pub fn pay_share(ctx: Context<PayShare>) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        require!(isa.status == IsaStatus::Working as u8, IsaError::InvalidStatus);
        require!(isa.last_salary > 0, IsaError::NoSalary);

        // due = salary * percent / 100
        let mut due = isa.last_salary
            .checked_mul(isa.percent as u64).ok_or(IsaError::MathOverflow)?
            .checked_div(100).ok_or(IsaError::MathOverflow)?;

        // If paying due would exceed max_cap, reduce to remaining
        if isa.already_paid.checked_add(due).ok_or(IsaError::MathOverflow)? > isa.max_cap {
            let remaining = isa.max_cap.checked_sub(isa.already_paid).unwrap_or(0);
            due = remaining;
        }

        require!(due > 0, IsaError::NothingToPay);

        // Transfer from student ATA -> vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.student_ata.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.student.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, due)?;

        isa.already_paid = isa.already_paid.checked_add(due).ok_or(IsaError::MathOverflow)?;

        // Optionally: if already_paid reached max_cap -> mark completed
        if isa.already_paid >= isa.max_cap {
            isa.status = IsaStatus::Completed as u8;
        }

        Ok(())
    }

    /// Distribute `amount_to_distribute` tokens from vault to investors passed in remaining_accounts.
    /// Expect pairs in remaining_accounts: [stake_acc1, recipient_ata1, stake_acc2, recipient_ata2, ...]
    /// The function computes total_invested from passed stakes (client must pass all stakes or subset whose sum equals total_invested used).
// programs/skillvest/src/lib.rs

pub fn distribute_payments(
    ctx: Context<DistributePayments>,
    amount_to_distribute: u64
) -> Result<()> {
    // 1. Мутабельная ссылка на ISA State
    let isa = &mut ctx.accounts.isa_state;

    // --- Проверки ---
    require!(amount_to_distribute > 0, IsaError::InvalidAmount);
    let vault_balance = ctx.accounts.vault.amount;
    require!(vault_balance >= amount_to_distribute, IsaError::NoFunds);

    let rem = &ctx.remaining_accounts;
    require!(rem.len() % 2 == 0 && rem.len() > 0, IsaError::InvalidAccounts);

    // --- 2. ПРОХОД 1: Вычисление общей инвестированной суммы (total_invested) ---
    // Это должно быть сделано в первую очередь, чтобы вычислить пропорциональную долю.
    let mut total_invested: u128 = 0;

    for chunk in rem.chunks_exact(2) {
        let stake_info = &chunk[0];

        // Десериализация заимствует данные только на время и не сохраняется в Vec
        let stake_account: Account<InvestorStake> = Account::try_from(stake_info)?; 

        // Валидация
        require!(stake_account.isa == isa.key(), IsaError::InvalidStake);

        total_invested = total_invested
            .checked_add(stake_account.amount as u128)
            .ok_or(IsaError::MathOverflow)?;
    }

    require!(total_invested > 0, IsaError::NoInvestors);

    // --- 3. ПРОХОД 2: Распределение и перевод средств (CPI) ---

    let mut total_share_distributed: u64 = 0;
    // Signer seeds (Неизменяемое заимствование isa.owner и isa.bump)
    let isa_seeds = &[b"isa", isa.owner.as_ref(), &[isa.bump]];
    let signer = &[&isa_seeds[..]];

    for chunk in rem.chunks_exact(2) {
        let stake_info = &chunk[0];
        let ata_info = &chunk[1];
        // Десериализация заново (безопасно)
        let stake_acct: Account<InvestorStake> = Account::try_from(stake_info)?;
        let recipient_ata: Account<TokenAccount> = Account::try_from(ata_info)?;

        // Вычисление доли (share)
        let share = (amount_to_distribute as u128)
            .checked_mul(stake_acct.amount as u128).ok_or(IsaError::MathOverflow)?
            .checked_div(total_invested).ok_or(IsaError::MathOverflow)? as u64;

        if share == 0 {
            continue;
        }

        // CPI: Перевод средств
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: recipient_ata.to_account_info(),
            // **ИСПРАВЛЕНИЕ E0502:** Используем мутабельную ссылку `isa` для Authority.
            // Хотя `isa` заимствовано как мутабельное, `.to_account_info()` берет
            // неизменяемую ссылку на данные, но Rust разрешает это, так как ссылка
            // `isa` была определена как мутабельная.
            authority: isa.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer
        );
        token::transfer(cpi_ctx, share)?;
        // **ИСПРАВЛЕНИЕ ЛОГИКИ:** Обновляем ЛОКАЛЬНЫЙ счетчик внутри цикла.
        total_share_distributed = total_share_distributed
            .checked_add(share)
            .ok_or(IsaError::MathOverflow)?;
    }
    // --- 4. ФИНАЛЬНОЕ ОБНОВЛЕНИЕ СОСТОЯНИЯ ---
    // **ИСПРАВЛЕНИЕ E0502:** Мутабельная операция происходит ЗДЕСЬ,
    // после того, как все неизменяемые заимствования (CPI и seeds) завершились.
    isa.total_distributed = isa.total_distributed
        .checked_add(total_share_distributed)
        .ok_or(IsaError::MathOverflow)?;

    Ok(())
}

    /// Reporter flags dropout
    pub fn report_dropout(ctx: Context<ReportDropout>) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        isa.status = IsaStatus::DroppedOut as u8;
        msg!("ISA dropped out: {}", isa.owner);
        Ok(())
    }
}

/// ISA account data
#[account]
pub struct IsaState {
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    pub course_cost: u64,
    pub percent: u8,
    pub max_cap: u64,
    pub total_invested: u64,
    pub already_paid: u64,
    pub total_distributed: u64,
    pub last_salary: u64,
    pub status: u8,
    pub bump: u8,
}

/// Investor stake PDA
#[account]
pub struct InvestorStake {
    pub isa: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub initialized: bool,
    pub bump: u8,
}

/*** Accounts / Contexts ***/

#[derive(Accounts)]
#[instruction(course_cost: u64, percent: u8, max_cap: u64)]
pub struct InitializeIsa<'info> {
    /// ISA PDA (created here)
    #[account(
        init,
        payer = student,
        seeds = [b"isa", student.key().as_ref()],
        bump,
        space = 8 + 32 + 32 + 32 + 8 + 1 + 8 + 8 + 8 + 8 + 1 + 1
    )]
    pub isa_state: Account<'info, IsaState>,

    /// Vault ATA for ISA PDA: client must create ATA for the ISA PDA prior to calling this instruction.
    /// We require vault.mint == mint and vault.owner == isa_state.key()
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub student: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct Invest<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,

    /// InvestorStake PDA: init if needed
    #[account(
        init_if_needed,
        payer = investor,
        seeds = [b"stake", isa_state.key().as_ref(), investor.key().as_ref()],
        bump,
        space = 8 + 32 + 32 + 8 + 1 + 1
    )]
    pub investor_stake: Account<'info, InvestorStake>,

    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(mut, constraint = investor_ata.mint == isa_state.token_mint, constraint = investor_ata.owner == investor.key())]
    pub investor_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = vault.key() == isa_state.vault)]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ReleaseFunds<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,

    #[account(mut, constraint = vault.key() == isa_state.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub university_ata: Account<'info, TokenAccount>,

    /// Isa_state used as signer via PDA seeds
    /// In runtime pass isa_state.to_account_info() as isa_signer (no signer required)
    // pub isa_state_signer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateSalary<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,

    /// In production: check oracle is whitelisted
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct PayShare<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,

    #[account(mut)]
    pub student: Signer<'info>,

    #[account(mut, constraint = student_ata.mint == isa_state.token_mint, constraint = student_ata.owner == student.key())]
    pub student_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = vault.key() == isa_state.vault)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DistributePayments<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,

    #[account(mut, constraint = vault.key() == isa_state.vault)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    // investor stake and recipient ATA accounts passed via remaining_accounts as pairs
}

#[derive(Accounts)]
pub struct ReportDropout<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,

    pub reporter: Signer<'info>,
}

/*** Errors ***/
#[error_code]
pub enum IsaError {
    #[msg("Invalid percent")]
    InvalidPercent,
    #[msg("Invalid status for operation")]
    InvalidStatus,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("No funds in vault")]
    NoFunds,
    #[msg("No salary set")]
    NoSalary,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("No investors provided")]
    NoInvestors,
    #[msg("Invalid accounts")]
    InvalidAccounts,
    #[msg("Stake does not belong to this ISA")]
    InvalidStake,
    #[msg("Stake does not belong to this investor")]
    InvalidStakeOwner,
    #[msg("Vault has invalid mint")]
    InvalidVault,
    #[msg("Vault owner is not ISA PDA")]
    InvalidVaultOwner,
    #[msg("Funding exceeds course cost")]
    FundingExceedsCourseCost,
    #[msg("Nothing to pay")]
    NothingToPay,
}

/*** Status enum ***/
#[repr(u8)]
pub enum IsaStatus {
    Learning = 0,
    StudyingPaid = 1,
    Working = 2,
    Delinquent = 3,
    DroppedOut = 4,
    Completed = 5,
    Unemployed = 6,
}
