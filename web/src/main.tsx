import { createRoot } from 'react-dom/client';
// Poppins is only for printed bills and statements (their look is unchanged); the screens use the device's own font.
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import './styles.css';
import { App } from './App';
import { applyTheme, getStoredTheme } from './state';

applyTheme(getStoredTheme());
createRoot(document.getElementById('root')!).render(<App />);
