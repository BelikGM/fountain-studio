/**
 * Самопроверка экрана «почему ничего не играет» (shared/whyquiet.ts).
 *
 * Разбор чистый — ни движка, ни сети не нужно: подставляем состояние и
 * смотрим, что человек прочитает. Главное здесь — ПОРЯДОК: первая строка
 * должна быть той самой причиной, из-за которой фонтан стоит, а не первой
 * попавшейся мелочью.
 *
 * Запуск: npm -w @fountain-studio/engine run why-test
 */
import { whyQuiet, type QuietFacts } from '@fountain-studio/shared';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean | undefined, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** Всё хорошо: объект открыт, играет сцена, мешать нечему. */
const ok: QuietFacts = {
  connected: true,
  licensed: true,
  licenseReason: '',
  projectOpen: true,
  devices: 6,
  universes: 1,
  universesWithOutput: 1,
  failsafe: { active: false, reason: '' },
  pausedAll: false,
  dark: null,
  sceneOn: true,
  sequences: 0,
  showOn: false,
  playlistOn: false,
  idleSceneSet: false,
  windLimitPercent: 100,
  windCorrecting: false,
  schedulesEnabled: 1,
  scheduleEntriesEnabled: 3,
  nextEntryTime: '21:00',
  needsAudioPlayer: false,
  outputsDelivering: true,
};
const with_ = (patch: Partial<QuietFacts>): QuietFacts => ({ ...ok, ...patch });

{
  const a = whyQuiet(ok);
  check('когда всё хорошо — «всё работает»', a.items.length === 0 && a.headline.includes('Всё работает'), a.headline);
  check('играет — так и сказано', a.playing);
}
{
  const a = whyQuiet(with_({ connected: false }));
  check('нет связи с движком — первым делом', a.headline === 'Нет связи с движком' && a.items[0]?.what.includes('не видит движок'), a.headline);
}
{
  const a = whyQuiet(with_({ projectOpen: false, sceneOn: false }));
  check('объект не открыт — первым делом', a.headline === 'Проект не открыт', a.headline);
  check('про пустое расписание при закрытом объекте не говорим', !a.items.some((i) => i.what.includes('расписание пустое')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ failsafe: { active: true, reason: 'выход не доставляет кадры 3 с' } }));
  check('авария важнее всего остального', a.headline.includes('аварийное отключение'), a.headline);
  check('причина аварии показана человеку', a.items[0]?.fix.includes('3 с'), JSON.stringify(a.items[0]));
}
{
  const a = whyQuiet(with_({ dark: 'off', sceneOn: false }));
  check('стоп по расписанию — главный ответ', a.headline.includes('стопом по расписанию'), a.headline);
  check('сказано, как включить раньше', a.items[0]?.fix.includes('руками'), JSON.stringify(a.items[0]));
  check('после стопа не бубним «ничего не запущено»', !a.items.some((i) => i.what.startsWith('Ничего не запущено')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ pausedAll: true }));
  check('пауза всего названа', a.headline === 'Всё на паузе', a.headline);
}
{
  const a = whyQuiet(with_({ sceneOn: false, scheduleEntriesEnabled: 0 }));
  check('нечего ждать — «запустите руками»', a.items[0]?.what.includes('расписание пустое'), JSON.stringify(a.items[0]));
}
{
  const a = whyQuiet(with_({ sceneOn: false, schedulesEnabled: 0 }));
  check('все расписания выключены — сказано прямо', a.items[0]?.what.includes('все расписания выключены'), JSON.stringify(a.items[0]));
}
{
  const a = whyQuiet(with_({ sceneOn: false }));
  check('ждём расписание — со временем ближайшей записи', a.items[0]?.fix.includes('21:00'), JSON.stringify(a.items[0]));
}
{
  const a = whyQuiet(with_({ sceneOn: false, idleSceneSet: true }));
  check('про сцену покоя сказано отдельно', a.items.some((i) => i.what.includes('сцена, когда ничего не играет')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ universes: 1, universesWithOutput: 0 }));
  check('вселенная без выхода — «уходить некуда»', a.items.some((i) => i.what.includes('не настроен выход')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ universes: 0, universesWithOutput: 0 }));
  check('нет вселенных — сказано именно это', a.items.some((i) => i.what.includes('ни одной вселенной')), JSON.stringify(a.items));
  check('и не дублируется «нет выхода»', !a.items.some((i) => i.what.includes('не настроен выход')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ outputsDelivering: null }));
  check('пока про доставку ничего не знаем — молчим', !a.items.some((i) => i.what.includes('не доставляет')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ outputsDelivering: false }));
  check('кадры не доходят — ведём на «Диагностику»', a.items.some((i) => i.what.includes('не доставляет') && i.tab === 'network'), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ windCorrecting: true, windLimitPercent: 62 }));
  check('ветер режет струи — с процентом', a.items.some((i) => i.what.includes('62 %')), JSON.stringify(a.items));
  check('играет, но есть что проверить', a.headline.includes('есть что проверить'), a.headline);
}
{
  const a = whyQuiet(with_({ needsAudioPlayer: true }));
  check('нечем играть музыку — попало в список', a.items.some((i) => i.what.includes('Нечем играть музыку')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ devices: 0, sceneOn: false }));
  check('пустой объект — «нет приборов»', a.items.some((i) => i.what.includes('нет приборов')), JSON.stringify(a.items));
}
{
  const a = whyQuiet(with_({ licensed: false, licenseReason: 'срок лицензии истёк' }));
  check('лицензия названа причиной', a.items.some((i) => i.what.includes('Лицензия') && i.fix.includes('истёк')), JSON.stringify(a.items));
}

console.log(`почему ничего не играет: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
