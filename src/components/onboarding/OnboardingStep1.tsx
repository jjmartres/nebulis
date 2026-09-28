import { User, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface OnboardingStep1Props {
  username: string;
  password: string;
  confirmPassword: string;
  userError: string;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  subText: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: () => void;
}

export function OnboardingStep1({
  username,
  password,
  confirmPassword,
  userError,
  isDark,
  inputClass,
  labelClass,
  subText,
  onUsernameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: OnboardingStep1Props) {
  const { t } = useTranslation('onboarding');
  return (
    <>
      <div className="flex items-center gap-3 mb-1">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
          <User className="w-5 h-5 text-emerald-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            {t('step1.heading')}
          </h3>
          <p className={`text-xs ${subText}`}>{t('step1.subheading')}</p>
        </div>
      </div>

      <div>
        <label className={labelClass}>{t('step1.usernameLabel')}</label>
        <input
          type="text"
          placeholder={t('step1.usernamePlaceholder')}
          value={username}
          onChange={e => onUsernameChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
          className={inputClass}
          autoFocus
        />
      </div>

      <div>
        <label className={labelClass}>{t('step1.passwordLabel')}</label>
        <input
          type="password"
          placeholder={t('step1.passwordPlaceholder')}
          value={password}
          onChange={e => onPasswordChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>{t('step1.confirmPasswordLabel')}</label>
        <input
          type="password"
          placeholder={t('step1.confirmPasswordPlaceholder')}
          value={confirmPassword}
          onChange={e => onConfirmPasswordChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
          className={`${inputClass} ${
            confirmPassword && password !== confirmPassword
              ? 'border-danger-500 focus:ring-danger-500/40'
              : ''
          }`}
        />
        {confirmPassword && password !== confirmPassword && (
          <p className="text-xs mt-1.5 text-danger-500 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {t('step1.passwordMismatch')}
          </p>
        )}
      </div>

      {userError && (
        <div className="flex items-center gap-2 text-sm text-danger-500">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {userError}
        </div>
      )}
    </>
  );
}
