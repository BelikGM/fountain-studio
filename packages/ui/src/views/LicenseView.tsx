import { useState } from 'react';
import type { EngineConnection } from '../useEngine';

/**
 * Активация лицензии (§27 доработки, «Продукт») — привязка к 1 ПК, офлайн
 * проверка подписи на движке (см. packages/engine/src/license.ts). Доступна
 * из шапки в любой момент, даже когда остальные вкладки закрыты без лицензии —
 * иначе активировать её было бы неоткуда.
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
              <p className="ok-text">
                ✔ Лицензия активна — {licenseStatus.licenseeName}
                {licenseStatus.expiresAt
                  ? `, до ${new Date(licenseStatus.expiresAt).toLocaleDateString('ru-RU')}`
                  : ' (бессрочно)'}
              </p>
            ) : (
              <p className="warn">
                ⚠ {licenseStatus.reason ?? 'Лицензия не активирована'} — без лицензии доступны только вкладки
                «Плейлисты» и «Расписание».
              </p>
            )}

            <div className="form-row">
              <span>ID этого компьютера:</span>
              <code className="license-machine-id">{licenseStatus.machineId}</code>
              <button className="btn" onClick={() => void copyMachineId()}>
                {copied ? '✔ скопировано' : 'Копировать'}
              </button>
            </div>
            <p className="dim">Отправьте этот ID продавцу — он выпустит файл лицензии для этого компьютера.</p>

            <div className="form-row">
              <label className="btn">
                {busy ? 'Проверяю…' : '⬆ Загрузить файл лицензии…'}
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
