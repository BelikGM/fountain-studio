import { SerialPort } from 'serialport';
import type { UsbDmxScan } from '@fountain-studio/shared';
import { d2xxError, d2xxProblem, loadD2xx } from './drivers/ftd2xx';
import { musidoraLinkStates } from './drivers/musidora';

/**
 * Что есть на компьютере для USB-DMX: библиотека драйвера FTDI, найденные ей
 * устройства, COM-порты и состояние интерфейсов Musidora, на которые мы пишем.
 * Вкладка «Настройки» опрашивает это, пока открыта, — так на объекте сразу
 * видно, нашёлся ли интерфейс и уходят ли кадры.
 */
/**
 * Порты «как будто подключены» — только для снимков редактора на изолированном
 * движке (ui-shots, поле engineEnv): на машине разработчика переходников нет, а
 * выбор порта надо видеть с настоящими строками. Формат: «COM3:0403,COM1:».
 */
function testPorts(): UsbDmxScan['ports'] {
  const spec = process.env.FOUNTAIN_TEST_COM_PORTS;
  if (!spec) return [];
  return spec.split(',').map((item) => {
    const [p = '', vid = ''] = item.split(':');
    return { path: p.trim(), manufacturer: '', vendorId: vid.trim(), productId: '', serialNumber: '' };
  });
}

export async function scanUsbDmx(): Promise<UsbDmxScan> {
  const d2 = await loadD2xx(true);
  let ports: UsbDmxScan['ports'] = [];
  try {
    ports = (await SerialPort.list()).map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer ?? '',
      vendorId: p.vendorId ?? '',
      productId: p.productId ?? '',
      serialNumber: p.serialNumber ?? '',
    }));
  } catch {
    /* список портов — подсказка, без него настройки тоже работают */
  }
  ports.push(...testPorts());
  return {
    d2xx: d2 ? { ok: true, version: d2.version, dll: d2.dll } : { ok: false, error: d2xxError(), problem: d2xxProblem() },
    ftdi: d2 ? d2.list() : [],
    ports,
    links: musidoraLinkStates(),
    atMs: Date.now(),
  };
}
