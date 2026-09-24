import { createRoot } from 'react-dom/client';
import { installScrollHint } from './scrollHint';
import { installNumberSteps } from './numStep';
import { App } from './App';
import './styles.css';

// Полосы прокрутки проявляются только когда ими пользуются (см. scrollHint).
installScrollHint();
// Стрелки числовых полей — всегда ровно на шаг от числа в поле (см. numStep).
installNumberSteps();
createRoot(document.getElementById('root')!).render(<App />);
