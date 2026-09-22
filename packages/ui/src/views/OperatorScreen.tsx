import { useState } from 'react';
import { askConfirm } from '../components/ConfirmDialog';
import { PauseIcon, PlayIcon, StopIcon } from '../components/Icons';
import { checkOperatorPassword, unlockOperator } from '../operatorMode';
import type { EngineConnection } from '../useEngine';

/**
 * Экран оператора (§27 доработки, УХ п.8): крупные кнопки для дежурного
 * персонала/планшета — запуск плейлистов и сцен, общий стоп, пауза,
 * BLACKOUT. Никакого доступа к редактированию — остальные вкладки не
 * смонтированы вообще, пока не введён пароль.
 */
export function OperatorScreen({ engine, onUnlock }: { engine: EngineConnection; onUnlock: () => void }) {
  const { project, playback, send } = engine;
  const [unlocking, setUnlocking] = useState(false);
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');

  const tryUnlock = async (): Promise<void> => {
    if (await checkOperatorPassword(pw)) {
      unlockOperator();
      onUnlock();
    } else {
      setError('Неверный пароль');
      setPw('');
    }
  };

  const doBlackout = async (): Promise<void> => {
    const running: string[] = [];
    if (playback.show !== null) running.push('шоу');
    if (playback.playlist !== null) running.push('плейлист');
    if (playback.activeSceneId !== null) running.push('сцена');
    if (playback.running.length > 0) running.push(`секвенсоры (${playback.running.length})`);
    if (running.length > 0) {
      const ok = await askConfirm('Погасить фонтан?', {
        detail: `Сейчас идёт воспроизведение: ${running.join(', ')}. Кнопка остановит его и погасит все приборы.`,
        okLabel: 'Погасить',
      });
      if (!ok) return;
    }
    send({ type: 'blackout' });
  };

  return (
    <main className="operator-screen">
      <header className="operator-header">
        <span className="operator-title">Fountain Studio — режим оператора</span>
        {!unlocking ? (
          <button className="btn" onClick={() => setUnlocking(true)}>
            🔓 Разблокировать
          </button>
        ) : (
          <span className="operator-unlock">
            <input
              className="input"
              type="password"
              value={pw}
              placeholder="Пароль"
              autoFocus
              onChange={(e) => {
                setPw(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void tryUnlock();
                if (e.key === 'Escape') setUnlocking(false);
              }}
            />
            <button className="btn" onClick={() => void tryUnlock()}>
              Войти
            </button>
            {error && <span className="error-text">{error}</span>}
          </span>
        )}
      </header>

      {!project ? (
        <p className="dim">Жду данные объекта от движка…</p>
      ) : (
        <>
          <section className="operator-transport">
            <button
              className={playback.pausedAll ? 'btn btn-big btn-icon active' : 'btn btn-big btn-icon btn-warn'}
              onClick={() => send({ type: playback.pausedAll ? 'resumeAll' : 'pauseAll' })}
            >
              {playback.pausedAll ? (
                <>
                  <PlayIcon />
                  Продолжить
                </>
              ) : (
                <>
                  <PauseIcon />
                  Пауза
                </>
              )}
            </button>
            <button className="btn btn-big btn-icon" onClick={() => send({ type: 'stopAllPlayback' })}>
              <StopIcon />
              Стоп всё
            </button>
            <button className="btn btn-big btn-danger" onClick={() => void doBlackout()}>
              ⚠ Погасить всё
            </button>
          </section>

          <section>
            <h2>Плейлисты</h2>
            <div className="operator-grid">
              {project.playlists.length === 0 && <p className="dim">Плейлистов пока нет.</p>}
              {project.playlists.map((p) => {
                const isLive = playback.playlist?.playlistId === p.id;
                return (
                  <button
                    key={p.id}
                    className={isLive ? 'btn btn-big btn-icon active' : 'btn btn-big btn-icon'}
                    onClick={() => send(isLive ? { type: 'stopPlaylist' } : { type: 'playPlaylist', playlistId: p.id })}
                  >
                    {isLive ? <StopIcon /> : <PlayIcon />}
                    {p.name}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h2>Сцены</h2>
            <div className="operator-grid">
              {project.scenes.length === 0 && <p className="dim">Сцен пока нет.</p>}
              {project.scenes.map((s) => {
                const isLive = playback.activeSceneId === s.id;
                return (
                  <button
                    key={s.id}
                    className={isLive ? 'btn btn-big btn-icon active' : 'btn btn-big btn-icon'}
                    onClick={() => send({ type: 'setScene', sceneId: isLive ? null : s.id })}
                  >
                    {isLive ? <StopIcon /> : <PlayIcon />}
                    {s.name}
                  </button>
                );
              })}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
