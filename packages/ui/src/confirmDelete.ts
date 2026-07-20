/**
 * Подтверждение удаления сущности верхнего уровня (сцена/секвенсор/шоу/
 * плейлист/прибор) — только когда её реально что-то использует; свободную
 * сущность удаляем молча, как и раньше. Родительная форма (kindGenitive) —
 * «сцены», «секвенсора», «шоу», «плейлиста», «прибора». window.confirm() уже
 * даёт Enter=ОК/Esc=отмена бесплатно, отдельно перехватывать не нужно.
 */
export function confirmDelete(kindGenitive: string, name: string, dependents: string[]): boolean {
  if (dependents.length === 0) return true;
  return window.confirm(
    `«${name}» используется: ${dependents.join(', ')}.\n\n` +
      `После удаления ${kindGenitive} эти привязки перестанут срабатывать. Удалить?`,
  );
}
