import { useState } from 'react';
import { UploadIcon } from '../components/Icons';
import { ANNUAL_DISCOUNT, CUSTOM_DEV_NOTE, PLANS, VENDOR_CONTACTS, priceLine } from '../plans';
import type { EngineConnection } from '../useEngine';

/**
 * Экран для совсем новой установки — лицензии не было НИКОГДА (access:
 * 'none' в LicenseStatus). Показывается вместо вкладок целиком, как
 * ProjectsView для noProject: работать не с чем, пока не выбран тариф и не
 * активирован файл лицензии.
 *
 * Отдельно от «истёк срок» (access: 'pro') — тот случай мягче: фонтан
 * продолжает играть по расписанию, здесь же — вообще ничего не настроено.
 */
const CONTACTS = VENDOR_CONTACTS;

export function WelcomeView({ engine }: { engine: EngineConnection }) {
  const { licenseStatus, activateLicense } = engine;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Подписка была и кончилась — это другой разговор, чем «впервые вижу программу». */
  const expired = licenseStatus?.expired === true;

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
      // Буфер обмена недоступен — ID всё равно виден текстом для ручного копирования.
    }
  };

  return (
    <main className="view">
      <section className="panel welcome-panel">
        {/*
          Один и тот же экран для двух разных людей: тому, кто видит программу
          впервые, нужно «что это и сколько стоит», а тому, у кого кончилась
          оплаченная подписка, — «продлите», он уже всё это выбирал и платил.
        */}
        <h2>{expired ? 'Подписка закончилась' : 'Добро пожаловать в Fountain Studio'}</h2>
        {expired ? (
          <p className="warn">
            ⚠ {licenseStatus?.reason ?? 'Срок подписки истёк'}. Объект и все настройки на месте — работа
            откроется сразу, как только продлите: напишите нам, пришлём новый файл лицензии.
          </p>
        ) : (
          <p className="dim">
            Программа управления светомузыкальными фонтанами: DMX512, таймлайн под музыку, 3D-визуализация
            струй и света. Чтобы начать работу, нужна лицензия — выберите тариф ниже и напишите нам.
          </p>
        )}

        <div className="plan-grid">
          {PLANS.map((p) => (
            <div key={p.id} className={p.id === 'max' ? 'plan-card plan-card-max' : 'plan-card'}>
              <div className="plan-card-title">
                {p.title}
                {p.id === 'max' && <span className="plan-card-badge">Полный доступ</span>}
              </div>
              <div className="plan-card-tagline">{p.tagline}</div>
              <div className="plan-card-price">{priceLine(p)}</div>
              <ul className="plan-card-features">
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <p className="dim plan-card-fit">{p.fitFor}</p>
            </div>
          ))}
        </div>
        <p className="dim" style={{ marginTop: 4 }}>
          Оплата за год сразу — скидка {Math.round(ANNUAL_DISCOUNT * 100)}% от месячной цены. {CUSTOM_DEV_NOTE}
        </p>

        <h3 style={{ marginTop: 20 }}>Как получить лицензию</h3>
        <p className="dim">
          Отправьте нам ID этого компьютера (кнопка ниже) и укажите, какой тариф выбрали — мы пришлём файл
          лицензии в ответ. Дальше просто загрузите его этой же программой, кнопкой в самом низу.
        </p>

        {licenseStatus && (
          <div className="form-row">
            <span>ID этого компьютера:</span>
            <code className="license-machine-id">{licenseStatus.machineId}</code>
            <button className="btn" onClick={() => void copyMachineId()}>
              {copied ? '✔ скопировано' : 'Копировать'}
            </button>
          </div>
        )}

        <div className="contact-row">
          <span>
            ✉ <a href={`mailto:${CONTACTS.email}`}>{CONTACTS.email}</a>
          </span>
          {CONTACTS.telegram && <span>Telegram: {CONTACTS.telegram}</span>}
          {CONTACTS.vk && <span>ВКонтакте: {CONTACTS.vk}</span>}
          {CONTACTS.phone && <span>Тел.: {CONTACTS.phone}</span>}
        </div>

        <div className="form-row" style={{ marginTop: 18 }}>
          <label className="btn btn-icon active">
            <UploadIcon />
            {busy ? 'Проверяю…' : 'У меня уже есть файл лицензии — загрузить'}
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
        {licenseStatus?.reason && (
          <p className="dim" style={{ marginTop: 6 }}>
            {licenseStatus.reason}
          </p>
        )}
      </section>
    </main>
  );
}
