import { createRoot } from 'react-dom/client';
import { installScrollHint } from './scrollHint';
import { App } from './App';
import './styles.css';

// Полосы прокрутки проявляются только когда ими пользуются (см. scrollHint).
installScrollHint();
createRoot(document.getElementById('root')!).render(<App />);
