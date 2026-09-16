import { askConfirm } from './components/ConfirmDialog';

/**
 * Подтверждение удаления сущности верхнего уровня (сцена/секвенсор/шоу/
 * плейлист/прибор) — только когда её реально что-то использует; свободную
 * сущность удаляем молча, как и раньше. Родительная форма (kindGenitive) —
 * «сцены», «секвенсора», «шоу», «плейлиста», «прибора».
 *
 * Раньше здесь был window.confirm. Теперь — общее окно приложения, поэтому
 * функция асинхронная: вызовы обёрнуты в await у всех вкладок.
 */
export async function confirmDelete(
  kindGenitive: string,
  name: string,
  dependents: string[],
): Promise<boolean> {
  if (dependents.length === 0) return true;
  return askConfirm(`Удалить «${name}»?`, {
    detail:
      `Используется: ${dependents.join(', ')}. ` +
      `После удаления ${kindGenitive} эти привязки перестанут срабатывать.`,
  });
}
