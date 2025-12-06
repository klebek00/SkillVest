use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("E9kqJYGA1fXhVqdE8eLYy2C98FD4Bv44Nud5aiNtjwJA");

#[program]
pub mod isa_contract {
    use super::*;

    /// Инициализация глобального конфига (Админ, Оракул, Университет)
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        oracle_key: Pubkey,
        university_key: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.payer.key(); // Тот, кто вызывает, становится админом
        config.oracle = oracle_key;
        config.university = university_key;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Смена Оракула (Только Админ)
    pub fn set_oracle(ctx: Context<SetOracle>, new_oracle_key: Pubkey) -> Result<()> {
        ctx.accounts.config.oracle = new_oracle_key;
        Ok(())
    }

    /// Смена Университета (Только Админ)
    pub fn set_university(ctx: Context<SetUniversity>, new_university_key: Pubkey) -> Result<()> {
        ctx.accounts.config.university = new_university_key;
        Ok(())
    }

    /// Инициализация ISA студентом
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

        require!(ctx.accounts.vault.mint == isa.token_mint, IsaError::InvalidVault);
        let expected_isa_pda = ctx.accounts.isa_state.key();
        require!(ctx.accounts.vault.owner == expected_isa_pda, IsaError::InvalidVaultOwner);

        Ok(())
    }

    /// Инвестирование (Investor -> Vault)
    pub fn invest(ctx: Context<Invest>, amount: u64) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        require!(isa.status == IsaStatus::Learning as u8, IsaError::InvalidStatus);
        require!(amount > 0, IsaError::InvalidAmount);

        if isa.total_invested.checked_add(amount).ok_or(IsaError::MathOverflow)? > isa.course_cost {
            return err!(IsaError::FundingExceedsCourseCost);
        }

        let cpi_accounts = Transfer {
            from: ctx.accounts.investor_ata.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        isa.total_invested = isa.total_invested.checked_add(amount).ok_or(IsaError::MathOverflow)?;

        let stake = &mut ctx.accounts.investor_stake;
        if !stake.initialized {
            stake.isa = isa.key();
            stake.investor = ctx.accounts.investor.key();
            stake.amount = amount;
            stake.initialized = true;
            stake.bump = ctx.bumps.investor_stake;
        } else {
            require!(stake.isa == isa.key(), IsaError::InvalidStake);
            require!(stake.investor == ctx.accounts.investor.key(), IsaError::InvalidStakeOwner);
            stake.amount = stake.amount.checked_add(amount).ok_or(IsaError::MathOverflow)?;
        }

        Ok(())
    }

    /// Выплата средств университету (Vault -> University)
    pub fn release_funds_to_university(ctx: Context<ReleaseFunds>) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        require!(isa.status == IsaStatus::Learning as u8, IsaError::InvalidStatus);

        let vault_balance = ctx.accounts.vault.amount;
        require!(vault_balance > 0, IsaError::NoFunds);

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

    /// Обновление зарплаты (Только Оракул)
    pub fn update_salary(ctx: Context<UpdateSalary>, salary: u64) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        isa.last_salary = salary;
        isa.status = if salary == 0 { IsaStatus::Unemployed as u8 } else { IsaStatus::Working as u8 };
        Ok(())
    }

    /// Выплата доли студентом (Student -> Vault)
    pub fn pay_share(ctx: Context<PayShare>) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;
        require!(isa.status == IsaStatus::Working as u8 || isa.status == IsaStatus::Delinquent as u8,
             IsaError::InvalidStatus);
        require!(isa.last_salary > 0, IsaError::NoSalary);

        let mut due = isa.last_salary
            .checked_mul(isa.percent as u64).ok_or(IsaError::MathOverflow)?
            .checked_div(100).ok_or(IsaError::MathOverflow)?;

        if isa.already_paid.checked_add(due).ok_or(IsaError::MathOverflow)? > isa.max_cap {
            let remaining = isa.max_cap.checked_sub(isa.already_paid).unwrap_or(0);
            due = remaining;
        }

        require!(due > 0, IsaError::NothingToPay);

        let cpi_accounts = Transfer {
            from: ctx.accounts.student_ata.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.student.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, due)?;

        isa.already_paid = isa.already_paid.checked_add(due).ok_or(IsaError::MathOverflow)?;

        if isa.status == IsaStatus::Delinquent as u8 {
            isa.status = IsaStatus::Working as u8;
        }

        if isa.already_paid >= isa.max_cap {
            isa.status = IsaStatus::Completed as u8;
        }

        Ok(())
    }

    /// Распределение средств инвесторам (Vault -> Investor ATAs)
    pub fn distribute_payments<'info>(
        ctx: Context<'_, '_, 'info, 'info, DistributePayments<'info>>,
        amount_to_distribute: u64
    ) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;

        require!(amount_to_distribute > 0, IsaError::InvalidAmount);
        let vault_balance = ctx.accounts.vault.amount;
        require!(vault_balance >= amount_to_distribute, IsaError::NoFunds);

        let rem = ctx.remaining_accounts;
        require!(rem.len() % 2 == 0 && rem.len() > 0, IsaError::InvalidAccounts);

        let mut total_invested: u128 = 0;

        for chunk in rem.chunks_exact(2) {
            let stake_info = &chunk[0];
            let stake_account: Box<Account<InvestorStake>> = Box::new(Account::try_from(stake_info)?); 
            
            require!(stake_account.isa == isa.key(), IsaError::InvalidStake);

            total_invested = total_invested
                .checked_add(stake_account.amount as u128)
                .ok_or(IsaError::MathOverflow)?;
        }

        require!(total_invested > 0, IsaError::NoInvestors);

        let mut total_share_distributed: u64 = 0;
        let isa_seeds = &[b"isa", isa.owner.as_ref(), &[isa.bump]];
        let signer = &[&isa_seeds[..]];

        for chunk in rem.chunks_exact(2) {
            let stake_info = &chunk[0];
            let ata_info = &chunk[1];
            
            let stake_acct: Box<Account<InvestorStake>> = Box::new(Account::try_from(stake_info)?);
            let recipient_ata: Account<TokenAccount> = Account::try_from(ata_info)?;

            let share = (amount_to_distribute as u128)
                .checked_mul(stake_acct.amount as u128).ok_or(IsaError::MathOverflow)?
                .checked_div(total_invested).ok_or(IsaError::MathOverflow)? as u64;

            if share == 0 {
                continue;
            }

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: recipient_ata.to_account_info(),
                authority: isa.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer
            );
            token::transfer(cpi_ctx, share)?;
            
            total_share_distributed = total_share_distributed
                .checked_add(share)
                .ok_or(IsaError::MathOverflow)?;
        }

        isa.total_distributed = isa.total_distributed
            .checked_add(total_share_distributed)
            .ok_or(IsaError::MathOverflow)?;

        Ok(())
    }

    pub fn report_dropout(ctx: Context<ReportDropout>) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;

        // 1. Проверка: Запретить завершение уже завершенных контрактов
        require!(
            isa.status != IsaStatus::Completed as u8 && isa.status != IsaStatus::DroppedOut as u8,
            IsaError::InvalidStatus
        );

        // 2. Обнуление обязательств (фиксируем потерю для инвесторов)
        isa.max_cap = 0;
        isa.percent = 0;

        // 3. Установка нового статуса
        isa.status = IsaStatus::DroppedOut as u8;

        msg!("ISA for {} permanently terminated due to dropout.", isa.owner);
        Ok(())
    }

    // --- lib.rs (Новая функция) ---

    pub fn report_delinquency(ctx: Context<ReportDelinquency>) -> Result<()> {
        let isa = &mut ctx.accounts.isa_state;

        // 1. Проверка статуса
        // Студент должен быть трудоустроен (Working) или безработным (Unemployed), 
        // но точно не Completed, DroppedOut или StudyingPaid.
        require!(
            isa.status == IsaStatus::Working as u8 || isa.status == IsaStatus::Unemployed as u8,
            IsaError::InvalidStatusForDelinquency
        );
        
        // 2. Проверка зарплаты
        // Студент не может быть в просрочке, если у него нет дохода или Оракул не установил доход.
        require!(isa.last_salary > 0, IsaError::NoSalaryToReportDelinquency);

        // 3. Установка статуса просрочки
        isa.status = IsaStatus::Delinquent as u8;

        msg!("ISA for {} reported as delinquent.", isa.owner);
        Ok(())
    }
}

// --- СТРУКТУРЫ ДАННЫХ ---

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

#[account]
pub struct InvestorStake {
    pub isa: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub initialized: bool,
    pub bump: u8,
}

#[account]
pub struct ISAConfig {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub university: Pubkey,
    pub bump: u8,
}

// --- КОНТЕКСТЫ ---

#[derive(Accounts)]
#[instruction(course_cost: u64, percent: u8, max_cap: u64)]
pub struct InitializeIsa<'info> {
    #[account(
        init,
        payer = student,
        seeds = [b"isa", student.key().as_ref()],
        bump,
        space = 160
    )]
    pub isa_state: Account<'info, IsaState>,

    #[account(
        init, // <--- ГОВОРИМ ANCHOR, ЧТО НУЖНО СОЗДАТЬ
        payer = student, // <--- КТО ПЛАТИТ ЗА СОЗДАНИЕ
        associated_token::mint = mint, // <--- МИНТ ДЛЯ ЭТОГО ATA
        associated_token::authority = isa_state, // <--- ВЛАДЕЛЕЦ: ISA PDA!
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub student: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(oracle_key: Pubkey, university_key: Pubkey)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [b"config"],
        bump,
        space = 8 + 32 + 32 + 32 + 1 
    )]
    pub config: Account<'info, ISAConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOracle<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ISAConfig>,
    #[account(
        signer, 
        constraint = admin.key() == config.admin @IsaError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>, 
}

#[derive(Accounts)]
pub struct SetUniversity<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ISAConfig>,
    #[account(
        signer, 
        constraint = admin.key() == config.admin @IsaError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>, 
}

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct Invest<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,
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
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ISAConfig>,
    #[account(
        mut, 
        constraint = university_ata.owner == config.university @IsaError::InvalidUniversity
    )]
    pub university_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateSalary<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ISAConfig>,
    /// CHECK:
    #[account(
        signer, 
        constraint = oracle.key() == config.oracle @IsaError::UnauthorizedOracle
    )]
    pub oracle: AccountInfo<'info>,
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
}

#[derive(Accounts)]
pub struct ReportDropout<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = university @IsaError::UnauthorizedUniversity
    )]
    pub config: Account<'info, ISAConfig>,

    pub university: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReportDelinquency<'info> {
    #[account(mut, seeds = [b"isa", isa_state.owner.as_ref()], bump = isa_state.bump)]
    pub isa_state: Account<'info, IsaState>,
    
    // Аккаунт Config для проверки полномочий Оракула
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, ISAConfig>,
    
    /// CHECK:
    #[account(
        signer, 
        constraint = oracle.key() == config.oracle @IsaError::UnauthorizedOracle
    )]
    pub oracle: AccountInfo<'info>, // Используем AccountInfo, как и в UpdateSalary
}

#[error_code]
pub enum IsaError {
    #[msg("Invalid percent")]
    InvalidPercent,
    #[msg("Invalid status for operation")]
    InvalidStatus,
    #[msg("Unauthorized oracle")]
    UnauthorizedOracle,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Unauthorized university")]
    UnauthorizedUniversity,
    #[msg("Invalid university account")]
    InvalidUniversity,
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
    #[msg("Invalid status for delinquency report")]
    InvalidStatusForDelinquency,
    #[msg("Cannot report delinquency when salary is 0")]
    NoSalaryToReportDelinquency,
}

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