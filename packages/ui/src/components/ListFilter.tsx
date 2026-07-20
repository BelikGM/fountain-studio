/** Поиск по имени над списком (сцены/секвенсоры/шоу/плейлисты) — §27 доработки, УХ п.7. */
export function ListFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      className="input list-filter"
      placeholder="Поиск…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
