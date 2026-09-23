/**
 * Настройки самого окна редактора — для «Резервной копии настроек программы».
 *
 * Они живут в браузере окна (localStorage), движок их не видит, поэтому при
 * сохранении копии редактор собирает их сам, а при восстановлении — сам же
 * раскладывает обратно (заказчик 24.09.2026: «копия сохраняет все-все
 * настройки?» — теперь да, кроме перечисленного ниже).
 *
 * Сознательно НЕ берём: блокировку режима оператора с её паролем (она про
 * конкретный компьютер — перенесённая на другой ПК, она заперла бы редактор
 * человеку, который пароля не знает), открытую вкладку, пройденный тур и
 * скрытые полосы-предупреждения — это состояние, а не настройки.
 */
const KEYS = [
  'fs-hotkeys', // горячие клавиши
  'fountain.view.prefs', // скорость камеры 3D
  'fountain.3d.hidden', // скрытое глазиком в 3D
  'fountain.settings.collapsed.v2', // свёрнутые панели «Настроек»
  'fs-theme', // тема оформления
];

export function collectUiPrefs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    } catch {
      // Приватный режим — просто нечего сохранить.
    }
  }
  return out;
}

export function applyUiPrefs(prefs: Record<string, string>): void {
  for (const k of KEYS) {
    const v = prefs[k];
    if (typeof v !== 'string') continue;
    try {
      localStorage.setItem(k, v);
    } catch {
      // Не записалось — останутся прежние.
    }
  }
}
