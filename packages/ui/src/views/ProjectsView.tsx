import { useEffect, useRef, useState } from 'react';
import type { EngineConnection } from '../useEngine';

/**
 * Выбор объекта: то, с чего начинается работа, если проект ещё не открыт.
 *
 * Здесь же — создание нового, копия под другим именем и переключение между
 * объектами. Список недавних ведёт движок в данных программы, а сами объекты
 * лежат папками: строка показывает путь, чтобы человек понимал, ГДЕ его фонтан,
 * и мог унести папку или прислать коллеге.
 *
 * Пропавшие папки из списка не прячем: человек должен видеть, что объект был,
 * и сам решить — найти его или убрать строку.
 */

/** Мостик в Electron. В браузере его нет — тогда путь вводится руками. */
interface DesktopApi {
  chooseProjectFolder(startIn: string): Promise<string>;
}
function desktop(): DesktopApi | undefined {
  return (window as unknown as { fountainApp?: DesktopApi }).fountainApp;
}

export function ProjectsView({ engine, onClose }: { engine: EngineConnection; onClose?: () => void }) {
  const { projects, projectResult, playback, send } = engine;
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [copying, setCopying] = useState(false);
  const [openPath, setOpenPath] = useState('');
  const firstOpenRef = useRef<HTMLButtonElement>(null);

  // Открылся объект — формы больше не нужны.
  useEffect(() => {
    if (projects?.current) {
      setCreating(false);
      setCopying(false);
      setName('');
    }
  }, [projects?.current]);

  // Самый свежий объект — под Enter: пришёл, нажал, работаешь.
  useEffect(() => {
    if (!creating && !copying) firstOpenRef.current?.focus();
  }, [creating, copying, projects?.recent.length]);

  if (!projects) {
    return (
      <main className="view">
        <section className="panel">
          <h2>Проекты</h2>
          <p className="dim">Ожидание ответа движка…</p>
        </section>
      </main>
    );
  }

  const recent = projects.recent;
  const first = recent.find((r) => !r.missing && r.dir !== projects.current?.dir);

  /*
   * Шоу играет — переключение объекта погасит фонтан на глазах у людей.
   * Спрашиваем, прежде чем переключать: это как раз тот случай, когда лишний
   * вопрос дешевле неожиданно потухшего фонтана.
   */
  const playing =
    playback.activeSceneId !== null ||
    playback.running.length > 0 ||
    playback.show !== null ||
    playback.playlist !== null;

  const askIfPlaying = (what: string): boolean =>
    !playing || window.confirm(`Сейчас идёт воспроизведение. ${what} — вывод на линию прервётся. Продолжить?`);

  const open = (dir: string): void => {
    if (askIfPlaying('Открыть другой объект')) send({ type: 'openProject', dir });
  };

  const create = (): void => {
    const n = name.trim();
    if (n === '' || !askIfPlaying('Создать новый объект')) return;
    send({ type: 'createProject', name: n });
  };

  const copy = (): void => {
    const n = name.trim();
    if (n === '' || !askIfPlaying('Открыть копию')) return;
    send({ type: 'copyProject', name: n });
  };

  const browse = async (): Promise<void> => {
    const api = desktop();
    if (!api) return;
    const dir = await api.chooseProjectFolder(projects.projectsRoot);
    if (dir !== '') open(dir);
  };

  return (
    <main className="view">
      <section className="panel">
        <h2>{projects.current ? 'Проекты' : 'С какого объекта начнём?'}</h2>
        <p className="dim">
          Объект — это папка на диске: в ней схема и адреса, настройки линий DMX, музыка шоу, журнал и
          резервные копии. Папку можно унести на флешке или прислать коллеге — у него откроется то же
          самое. Объектов может быть сколько угодно.
        </p>

        {projects.current && (
          <p className="ok-text">
            ✔ Открыт: <b>{projects.current.name}</b> <span className="dim">· {projects.current.dir}</span>
          </p>
        )}

        {projectResult && (
          <p className={projectResult.ok ? 'ok-text' : 'error-text'} style={{ marginLeft: 0 }}>
            {projectResult.ok ? '✔ ' : '✖ '}
            {projectResult.message}
          </p>
        )}

        <h3 style={{ marginBottom: 6 }}>Недавние</h3>
        {recent.length === 0 ? (
          <p className="dim">Пока ни одного объекта — создайте первый.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Объект</th>
                <th>Где лежит</th>
                <th>Открывали</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const isOpen = projects.current?.dir === r.dir;
                return (
                  <tr key={r.dir} className={r.missing ? 'row-error' : undefined}>
                    <td>
                      <b>{r.name}</b>
                      {isOpen && <span className="ok-text"> · открыт</span>}
                      {r.missing && <span className="error-text"> · папка не найдена</span>}
                    </td>
                    <td className="dim" style={{ maxWidth: 420, overflowWrap: 'anywhere' }}>
                      {r.dir}
                    </td>
                    <td className="dim">{r.openedAtMs > 0 ? new Date(r.openedAtMs).toLocaleString('ru-RU') : '—'}</td>
                    <td>
                      {!r.missing && !isOpen && (
                        <button
                          {...(r.dir === first?.dir ? { ref: firstOpenRef } : {})}
                          className={r.dir === first?.dir ? 'btn btn-small active' : 'btn btn-small'}
                          {...(r.dir === first?.dir ? { 'data-hint': 'Самый свежий объект — открывается по Enter' } : {})}
                          onClick={() => open(r.dir)}
                        >
                          Открыть
                        </button>
                      )}{' '}
                      <button
                        className="btn btn-small"
                        data-hint="Убрать из списка. Сама папка объекта на диске остаётся — удалить её можно только вручную."
                        onClick={() => send({ type: 'forgetProject', dir: r.dir })}
                      >
                        Убрать
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: 18, marginBottom: 6 }}>Объект из другой папки</h3>
        <div className="form-row">
          {desktop() && (
            <button
              className="btn"
              data-hint="Выбрать папку объекта на диске — например, ту, что прислали на флешке."
              onClick={() => void browse()}
            >
              📁 Выбрать папку…
            </button>
          )}
          <input
            className="input"
            style={{ width: 380 }}
            placeholder="или путь: D:\Фонтаны\Новороссийск"
            value={openPath}
            data-hint="Путь к папке объекта (или к файлу project.json / .fsproj внутри неё)."
            onChange={(e) => setOpenPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && openPath.trim() !== '') open(openPath.trim());
            }}
          />
          <button className="btn btn-small" disabled={openPath.trim() === ''} onClick={() => open(openPath.trim())}>
            Открыть
          </button>
        </div>

        <h3 style={{ marginTop: 18, marginBottom: 6 }}>Новый объект</h3>
        {creating || copying ? (
          <div className="form-row">
            <label className="field">
              Название:{' '}
              <input
                className="input"
                style={{ width: 260 }}
                autoFocus
                value={name}
                placeholder={copying ? `${projects.current?.name ?? ''} — вариант 2` : 'Новороссийск'}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (copying ? copy : create)();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setCopying(false);
                  }
                }}
              />
            </label>
            <button className="btn active" disabled={name.trim() === ''} onClick={copying ? copy : create}>
              {copying ? 'Сделать копию' : 'Создать'}
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                setCreating(false);
                setCopying(false);
              }}
            >
              Отмена
            </button>
            <span className="dim">
              {copying
                ? 'Копия ляжет рядом с остальными объектами: схема, линии и музыка те же, журнал и бэкапы начнутся заново.'
                : `Папка появится в ${projects.projectsRoot}. Внутри сразу будет одна линия DMX.`}
            </span>
          </div>
        ) : (
          <div className="form-row">
            <button
              className="btn"
              onClick={() => {
                setName('');
                setCreating(true);
              }}
            >
              + Создать проект
            </button>
            {projects.current && (
              <>
                <button
                  className="btn btn-small"
                  data-hint="Копия открытого объекта под другим именем: попробовать второй вариант шоу, не трогая рабочий."
                  onClick={() => {
                    setName(`${projects.current?.name ?? ''} — вариант 2`);
                    setCopying(true);
                  }}
                >
                  Сохранить как…
                </button>
                <button
                  className="btn btn-small"
                  data-hint="Закрыть объект: вывод на линию прекратится, программа вернётся к выбору проекта."
                  onClick={() => {
                    if (askIfPlaying('Закрыть объект')) send({ type: 'closeProject' });
                  }}
                >
                  Закрыть объект
                </button>
                {onClose && (
                  <button className="btn btn-small" onClick={onClose}>
                    ← Вернуться к работе
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <p className="dim" style={{ marginTop: 16 }}>
          Объект можно открыть и не заходя в программу: в его папке лежит файл с расширением
          <b> .fsproj</b> — двойной щелчок по нему открывает этот фонтан сразу.
        </p>
      </section>
    </main>
  );
}
