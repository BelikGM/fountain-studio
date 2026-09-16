import { useEffect, useMemo, useRef, useState } from 'react';
import { countHits, searchRecords, type SearchGroup, type SearchRecord } from '@fountain-studio/shared';

/**
 * Поиск-лупа в духе строки поиска Windows: в покое — только значок без рамок,
 * при наведении он раскрывается в овальное поле, и лупа остаётся ЕГО ЧАСТЬЮ.
 *
 * Важно, что это одно тело, а не кнопка плюс поле рядом: иначе при наведении
 * на значок поле появляется сбоку, и курсор, идя к нему, успевает соскочить с
 * кнопки. Здесь всё наоборот — растёт сам элемент, лупа внутри него, и увести
 * курсор мимо уже некуда.
 *
 * Находки показываются группами по полю, в котором совпало: одно и то же слово
 * может быть и типом, и куском имени, и цифрой в координате. Но если все поля
 * нашли одно и то же — группа одна, без лишних заголовков (см. searchRecords).
 */
export function SmartSearch({
  records,
  onPick,
  value,
  onValue,
  placeholder = 'Поиск',
  hint,
}: {
  records: SearchRecord[];
  /** Клик по находке. */
  onPick: (id: string) => void;
  /** Текст запроса — держим снаружи, чтобы им же фильтровать список. */
  value: string;
  onValue: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showList, setShowList] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(() => searchRecords(records, value), [records, value]);
  const total = countHits(groups);

  // Клик мимо — сворачиваем, если ничего не набрано.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current?.contains(e.target as Node)) return;
      setShowList(false);
      if (value.trim() === '') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, value]);

  const expand = (): void => {
    setOpen(true);
    setShowList(true);
    // Фокус ставим после перерисовки, иначе поля ещё нет.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div
      className={open ? 'smart-search open' : 'smart-search'}
      ref={boxRef}
      data-hint={open ? undefined : (hint ?? 'Поиск по всем свойствам: имя, тип, координаты, адрес')}
      onMouseEnter={expand}
      onMouseLeave={() => {
        if (value.trim() === '' && document.activeElement !== inputRef.current) {
          setOpen(false);
          setShowList(false);
        }
      }}
      onClick={() => {
        if (!open) expand();
        else inputRef.current?.focus();
      }}
    >
      <span className="smart-search-icon" aria-hidden>
        <svg viewBox="0 0 16 16" width="14" height="14">
          <circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.3 10.3 L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      <input
        ref={inputRef}
        className="smart-search-input"
        placeholder={placeholder}
        aria-label="Поиск"
        tabIndex={open ? 0 : -1}
        value={value}
        onFocus={() => {
          setOpen(true);
          setShowList(true);
        }}
        onChange={(e) => {
          onValue(e.target.value);
          setShowList(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          onValue('');
          setShowList(false);
          setOpen(false);
          inputRef.current?.blur();
        }}
      />
      {open && value.trim() !== '' && total > 0 && <span className="dim smart-search-count">{total}</span>}
      {open && showList && value.trim() !== '' && (
        <div className="smart-search-drop">
          {groups.length === 0 ? (
            <p className="dim">Ничего не найдено.</p>
          ) : (
            groups.map((g) => (
              <Group key={g.field || 'все'} group={g} alone={groups.length === 1} onPick={onPick} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Группа находок по одному полю. Если поле всего одно — раскрыта сразу и без
 * заголовка: прятать единственную группу за лишним кликом незачем.
 */
function Group({
  group,
  alone,
  onPick,
}: {
  group: SearchGroup;
  alone: boolean;
  onPick: (id: string) => void;
}) {
  const list = (
    <ul className="list">
      {group.hits.map((h) => (
        <li
          key={group.field + h.id}
          className="list-item"
          onClick={() => onPick(h.id)}
          title={`${h.kind}${group.field ? ` · ${group.field} = ${h.value}` : ''}`}
        >
          <span className="list-item-name">{h.label}</span>
          <span className="dim smart-search-val">{h.value}</span>
        </li>
      ))}
    </ul>
  );
  if (group.field === '') return list;
  return (
    <details className="smart-search-group" open={alone}>
      <summary>
        {group.field} <span className="dim">· {group.hits.length}</span>
      </summary>
      {list}
    </details>
  );
}
