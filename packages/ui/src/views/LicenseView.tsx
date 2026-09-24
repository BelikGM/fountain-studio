import { UploadIcon } from '../components/Icons';
import { useState } from 'react';
import { EXPIRY_WARNING_DAYS, GRACE_PERIOD_DAYS, daysUntilExpiry } from '@fountain-studio/shared';
import { PLANS, VENDOR_EMAIL, priceLine } from '../plans';
import type { EngineConnection } from '../useEngine';

/**
 * Активация лицензии (§27 доработки, «Продукт») — привязка к 1 ПК, офлайн
 * проверка подписи на движке (см. packages/engine/src/license.ts). Доступна
 * из шапки в любой момент, даже когда остальные вкладки закрыты без
 * лицензии — иначе активировать её было бы неоткуда.
 *
 * Экран для СОВСЕМ новой установки (access: 'none') — WelcomeView, не этот
 * компонент: там ещё и тарифы с ценами, сюда попадают уже зная, что покупают.
 */
export function LicenseView({ engine, onClose }: { engine: EngineConnection; onClose: () => void }) {
  const { licenseStatus, activateLicense } = engine;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const doActivate = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const text = await file.text();
      await activateLicense(text);
    } finally {
      setBusy(false);
    }
  };

  const copyMachineId = async (): Promise<void> => {
    if (!licenseStatus) return;
    try {
      await navigator.clipboard.writeText(licenseStatus.machineId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Буфер обмена недоступен (например, не https) — ID всё равно виден текстом для ручного копирования.
    }
  };

  const planInfo = licenseStatus ? PLANS.find((p) => p.id === licenseStatus.plan) : undefined;
  const daysLeft = licenseStatus?.licensed ? daysUntilExpiry(licenseStatus.expiresAt) : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal license-modal" onClick={(e) => e.stopPropagation()}>
        <div className="form-row">
          <span className="panel-title" style={{ width: 'auto' }}>
            Лицензия
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Закрыть
          </button>
        </div>

        {licenseStatus === null ? (
          <p className="dim">Запрашиваю статус лицензии…</p>
        ) : (
          <>
            {licenseStatus.licensed ? (
              <>
                <p className="ok-text">
                  ✔ {planInfo?.title ?? 'Лицензия'} активна — {licenseStatus.licenseeName}
                  {licenseStatus.expiresAt
                    ? `, до ${new Date(licenseStatus.expiresAt).toLocaleDateString('ru-RU')}`
                    : ' (бессрочно)'}
                </p>
                {/*
                  Два разных предупреждения: «скоро закончится» (ещё в сроке) и
                  «просрочено, идут льготные дни» — во втором случае счёт уже
                  пошёл, и текст должен быть жёстче.
                */}
                {licenseStatus.grace ? (
                  <p className="warn">
                    ⚠ {licenseStatus.reason ?? 'Оплата просрочена'}. Программа работает ещё{' '}
                    {licenseStatus.graceDaysLeft ?? 0} дн. — потом доступ закроется. Продление:{' '}
                    {VENDOR_EMAIL}
                    <br />
                    Оплата продлевает срок от прежней даты окончания, а не от дня оплаты.
                  </p>
                ) : (
                  daysLeft !== null &&
                  daysLeft <= EXPIRY_WARNING_DAYS && (
                    <p className="warn">
                      ⚠ {daysLeft > 0 ? `Остаётся ${daysLeft} дн.` : 'Последний день'} — напишите нам заранее,
                      чтобы продлить: {VENDOR_EMAIL}. После окончания будет ещё {GRACE_PERIOD_DAYS} льготных
                      дней, дальше работа закроется.
                    </p>
                  )
                )}
              </>
            ) : licenseStatus.expired ? (
              // Человек уже платил — ему нужно «продлите», а не «выберите тариф».
              <p className="warn">
                ⚠ {licenseStatus.reason ?? 'Срок подписки истёк'}. Работа с программой закрыта до продления —
                напишите нам: {VENDOR_EMAIL}
              </p>
            ) : (
              <p className="warn">
                ⚠ {licenseStatus.reason ?? 'Лицензия не активирована'} — доступа нет.
              </p>
            )}

            {licenseStatus.access === 'pro' && (
              <p className="dim">
                Тариф Max открывает разработку новых шоу, 3D-схему, оборудование и протоколы —{' '}
                {PLANS.find((p) => p.id === 'max') && priceLine(PLANS.find((p) => p.id === 'max')!)}.
              </p>
            )}

            <div className="form-row">
              <span>ID этого компьютера:</span>
              <code className="license-machine-id">{licenseStatus.machineId}</code>
              <button className="btn btn-icon" onClick={() => void copyMachineId()}>
                {copied ? '✔ скопировано' : 'Копировать'}
              </button>
            </div>
            <p className="dim">Отправьте этот ID продавцу — он выпустит файл лицензии для этого компьютера.</p>

            <div className="form-row">
              <label className="btn">
                <UploadIcon />
                {busy ? 'Проверяю…' : 'Загрузить файл лицензии…'}
                <input
                  type="file"
                  accept=".json"
                  style={{ display: 'none' }}
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void doActivate(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
