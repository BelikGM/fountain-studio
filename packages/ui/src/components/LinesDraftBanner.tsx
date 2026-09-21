import { describeLinesChange } from '@fountain-studio/shared';
import { applySettingsDraft, clearSettingsDraft, useSettingsDraft } from '../settingsDraft';
import type { EngineConnection } from '../useEngine';

/**
 * Плашка «правки вселенных не применены» — на всех вкладках, кроме самих
 * «Настроек» (там то же самое стоит прямо под таблицей).
 *
 * Зачем. 22.09.2026 заказчик добавил вторую вселенную, пошёл на «Поток» и в
 * привязку приборов — а её там нет: правка не применена, и никто, кроме
 * таблицы в «Настройках», об этом не знал. Для человека это выглядело как
 * «вселенная не добавилась». Теперь, куда бы он ни ушёл, он видит, что
 * именно ждёт применения, и может применить прямо отсюда — возвращаться в
 * «Настройки» не нужно.
 */
export function LinesDraftBanner({
  engine,
  onOpenSettings,
}: {
  engine: EngineConnection;
  onOpenSettings: () => void;
}) {
  const { draft, status, message } = useSettingsDraft();
  const cfg = engine.engineConfig;
  if (!draft || !cfg) return null;
  const pending = describeLinesChange(cfg, draft);
  if (pending.length === 0) return null;

  return (
    <div className={status === 'error' ? 'license-banner license-banner-grace' : 'license-banner'}>
      <span>
        {status === 'error'
          ? `⚠ ${message}`
          : `⚠ Не применено: ${pending.join('; ')}. Пока не применить, этого нет ни на вкладках, ни в линии.`}
      </span>
      <button
        className="btn btn-small active"
        disabled={status === 'pending'}
        data-hint="Применить на ходу: воспроизведение не останавливается"
        onClick={() => applySettingsDraft(engine.send, engine.connected)}
      >
        {status === 'pending' ? 'Применяю…' : 'Применить'}
      </button>
      <button className="btn btn-small" disabled={status === 'pending'} onClick={clearSettingsDraft}>
        Отменить
      </button>
      <button className="btn btn-small" onClick={onOpenSettings}>
        В настройки
      </button>
    </div>
  );
}
