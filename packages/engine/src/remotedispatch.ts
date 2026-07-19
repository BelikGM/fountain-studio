import type { RemoteAction } from '@fountain-studio/shared';
import type { Engine } from './engine';

/**
 * Исполнение RemoteAction (OSC/MQTT, §1 доработки) — прямое действие, без
 * тумблерной семантики клавиш (та живёт в браузере и знает состояние кнопки;
 * здесь источник — сеть, «повторное нажатие» не определено так же однозначно,
 * поэтому пульт/брокер должен явно слать «стоп» отдельным адресом/топиком).
 */
export function fireRemoteAction(engine: Engine, action: RemoteAction): void {
  switch (action.type) {
    case 'scene':
      engine.setScene(action.refId);
      break;
    case 'sequence':
      engine.startSequence(action.refId);
      break;
    case 'show':
      engine.playShow(action.refId, 0);
      break;
    case 'playlist':
      engine.playPlaylist(action.refId, undefined);
      break;
    case 'stopAll':
      engine.stopAllPlayback();
      break;
    case 'blackout':
      engine.blackout();
      break;
  }
}
