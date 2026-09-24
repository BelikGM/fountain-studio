import { useEffect, useState } from 'react';

/**
 * Подтверждение действия своим окном вместо window.confirm — одно на всё
 * приложение.
 *
 * Браузерный диалог выпадает сверху экрана с надписью «Подтвердите действие на
 * localhost:5180», выглядит чужеродно, а в собранном Electron-приложении тоже
 * рисуется системным. Здесь — то же модальное окно, что у Справки и Лицензии:
 * по центру, в оформлении программы.
 *
 * Обращение императивное, как к window.confirm, только через await — иначе
 * пришлось бы тащить состояние окна через все вкладки и вспомогательные
 * функции вроде confirmDelete, которые вообще не компоненты:
 *
 *   if (!(await askConfirm('Удалить сцену «Вечер»?'))) return;
 *
 * <ConfirmHost /> монтируется один раз в App; пока он не смонтирован,
 * askConfirm честно откатывается на window.confirm, чтобы подтверждение не
 * пропало совсем.
 */
export interface ConfirmOptions {
  /** Пояснение под вопросом — что именно произойдёт. */
  detail?: string;
  /** Подпись подтверждающей кнопки; по умолчанию «Удалить». */
  okLabel?: string;
  /** false — обычное действие, кнопка не красная. */
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  text: string;
  resolve: (ok: boolean) => void;
}

let openDialog: ((req: ConfirmRequest) => void) | null = null;

export function askConfirm(text: string, options?: ConfirmOptions): Promise<boolean> {
  if (!openDialog) return Promise.resolve(window.confirm(text));
  return new Promise<boolean>((resolve) => {
    openDialog!({ text, ...options, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    openDialog = (next) => {
      // Если окно уже открыто, старое обещание нужно закрыть, иначе вызвавший
      // его код останется ждать навсегда.
      setReq((prev) => {
        prev?.resolve(false);
        return next;
      });
    };
    return () => {
      openDialog = null;
    };
  }, []);

  const close = (ok: boolean): void => {
    setReq((prev) => {
      prev?.resolve(ok);
      return null;
    });
  };

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  if (!req) return null;
  return (
    // confirm-overlay — поверх любых других окон: подтверждение, открытое из
    // окна, не должно прятаться под ним.
    <div className="modal-overlay confirm-overlay" onClick={() => close(false)}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-text">{req.text}</div>
        {req.detail && <p className="dim confirm-detail">{req.detail}</p>}
        <div className="confirm-actions">
          <button className="btn" onClick={() => close(false)}>
            Отмена
          </button>
          <button
            className={req.danger === false ? 'btn active' : 'btn btn-danger'}
            autoFocus
            onClick={() => close(true)}
          >
            {req.okLabel ?? 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  );
}
