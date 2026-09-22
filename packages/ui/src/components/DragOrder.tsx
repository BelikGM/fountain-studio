import { useState, type DragEvent, type ReactElement } from 'react';

/**
 * Перетаскивание порядка в списках — одно на все вкладки.
 *
 * Порядок в списках не косметика: секвенсоры и шоу человек ищет глазами
 * сверху вниз, а у расписаний порядок решает спор — при совпадении времени
 * срабатывает первое по списку. Раньше перетаскивание было сделано
 * по-разному в четырёх местах и отсутствовало в остальных; здесь общий
 * кусок, чтобы везде вело себя одинаково.
 *
 * Список может быть отфильтрован (поиск слева): тащим по id, а переставляем
 * в ПОЛНОМ массиве — иначе фильтр перемешал бы то, чего не видно.
 */
export function useDragOrder<T extends { id: string }>(items: T[], apply: (next: T[]) => void) {
  const [dragId, setDragId] = useState<string | null>(null);

  const move = (fromId: string, toId: string): void => {
    const from = items.findIndex((x) => x.id === fromId);
    const to = items.findIndex((x) => x.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    apply(next);
  };

  return {
    dragId,
    /** На сам пункт списка: он принимает то, что на него тащат. */
    dropProps: (id: string) => ({
      onDragOver: (e: DragEvent) => e.preventDefault(),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (dragId) move(dragId, id);
        setDragId(null);
      },
    }),
    /**
     * Ручка «⠿». Тащим именно за неё, а не за весь пункт: по пункту щёлкают,
     * чтобы выбрать, и перетаскивание всего пункта мешало бы выбору.
     */
    handle: (id: string, hint: string): ReactElement => (
      <span
        className="drag-handle"
        data-hint={hint}
        draggable
        onDragStart={() => setDragId(id)}
        onDragEnd={() => setDragId(null)}
        onClick={(e) => e.stopPropagation()}
      >
        ⠿
      </span>
    ),
  };
}
