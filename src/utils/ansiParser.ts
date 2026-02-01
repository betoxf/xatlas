/**
 * ANSI to HTML Parser
 *
 * Converts ANSI escape codes to styled HTML spans for terminal preview rendering.
 * CRITICAL: All text is HTML-escaped BEFORE wrapping in spans to prevent XSS attacks.
 */

// Standard ANSI 16 colors (foreground codes 30-37 and 90-97)
const ANSI_COLORS: Record<number, string> = {
  // Standard colors (30-37)
  30: '#000000', // Black
  31: '#cc0000', // Red
  32: '#00cc00', // Green
  33: '#cccc00', // Yellow
  34: '#0000cc', // Blue
  35: '#cc00cc', // Magenta
  36: '#00cccc', // Cyan
  37: '#cccccc', // White
  // Bright colors (90-97)
  90: '#666666', // Bright Black (Gray)
  91: '#ff0000', // Bright Red
  92: '#00ff00', // Bright Green
  93: '#ffff00', // Bright Yellow
  94: '#0000ff', // Bright Blue
  95: '#ff00ff', // Bright Magenta
  96: '#00ffff', // Bright Cyan
  97: '#ffffff', // Bright White
};

// Background colors (40-47 and 100-107)
const ANSI_BG_COLORS: Record<number, string> = {
  40: '#000000',
  41: '#cc0000',
  42: '#00cc00',
  43: '#cccc00',
  44: '#0000cc',
  45: '#cc00cc',
  46: '#00cccc',
  47: '#cccccc',
  100: '#666666',
  101: '#ff0000',
  102: '#00ff00',
  103: '#ffff00',
  104: '#0000ff',
  105: '#ff00ff',
  106: '#00ffff',
  107: '#ffffff',
};

interface AnsiState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

/**
 * Escape HTML entities to prevent XSS attacks
 * This MUST be called on all text content before wrapping in HTML tags
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Parse SGR (Select Graphic Rendition) parameters and update state
 */
function parseAnsiCode(params: number[], state: AnsiState): void {
  for (let i = 0; i < params.length; i++) {
    const code = params[i];

    if (code === 0) {
      // Reset all attributes
      state.fg = null;
      state.bg = null;
      state.bold = false;
      state.dim = false;
      state.italic = false;
      state.underline = false;
      state.strikethrough = false;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 9) {
      state.strikethrough = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 29) {
      state.strikethrough = false;
    } else if (code === 39) {
      state.fg = null; // Default foreground
    } else if (code === 49) {
      state.bg = null; // Default background
    } else if (code >= 30 && code <= 37) {
      state.fg = ANSI_COLORS[code];
    } else if (code >= 90 && code <= 97) {
      state.fg = ANSI_COLORS[code];
    } else if (code >= 40 && code <= 47) {
      state.bg = ANSI_BG_COLORS[code];
    } else if (code >= 100 && code <= 107) {
      state.bg = ANSI_BG_COLORS[code];
    } else if (code === 38 && params[i + 1] === 5) {
      // 256-color foreground: \x1b[38;5;{n}m
      const colorIndex = params[i + 2];
      state.fg = get256Color(colorIndex);
      i += 2;
    } else if (code === 48 && params[i + 1] === 5) {
      // 256-color background: \x1b[48;5;{n}m
      const colorIndex = params[i + 2];
      state.bg = get256Color(colorIndex);
      i += 2;
    } else if (code === 38 && params[i + 1] === 2) {
      // RGB foreground: \x1b[38;2;{r};{g};{b}m
      const r = params[i + 2];
      const g = params[i + 3];
      const b = params[i + 4];
      state.fg = `rgb(${r},${g},${b})`;
      i += 4;
    } else if (code === 48 && params[i + 1] === 2) {
      // RGB background: \x1b[48;2;{r};{g};{b}m
      const r = params[i + 2];
      const g = params[i + 3];
      const b = params[i + 4];
      state.bg = `rgb(${r},${g},${b})`;
      i += 4;
    }
  }
}

/**
 * Get color from 256-color palette
 */
function get256Color(index: number): string {
  if (index < 0 || index > 255) return '#ffffff';

  // Standard colors (0-15)
  if (index < 16) {
    const colors = [
      '#000000', '#cc0000', '#00cc00', '#cccc00',
      '#0000cc', '#cc00cc', '#00cccc', '#cccccc',
      '#666666', '#ff0000', '#00ff00', '#ffff00',
      '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
    ];
    return colors[index];
  }

  // 216 colors (16-231): 6x6x6 color cube
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  // Grayscale (232-255): 24 shades
  const gray = 8 + (index - 232) * 10;
  const hex = gray.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

/**
 * Build CSS style string from ANSI state
 */
function buildStyleFromState(state: AnsiState): string {
  const styles: string[] = [];

  if (state.fg) {
    styles.push(`color:${state.fg}`);
  }
  if (state.bg) {
    styles.push(`background-color:${state.bg}`);
  }
  if (state.bold) {
    styles.push('font-weight:bold');
  }
  if (state.dim) {
    styles.push('opacity:0.7');
  }
  if (state.italic) {
    styles.push('font-style:italic');
  }
  if (state.underline) {
    styles.push('text-decoration:underline');
  }
  if (state.strikethrough) {
    styles.push('text-decoration:line-through');
  }

  return styles.join(';');
}

/**
 * Check if state has any active styles
 */
function hasActiveStyles(state: AnsiState): boolean {
  return !!(
    state.fg ||
    state.bg ||
    state.bold ||
    state.dim ||
    state.italic ||
    state.underline ||
    state.strikethrough
  );
}

/**
 * Convert ANSI-escaped text to HTML with styled spans
 *
 * SECURITY: All text is HTML-escaped before being wrapped in spans.
 * This prevents XSS attacks from terminal output containing malicious HTML.
 *
 * @param text - Text with ANSI escape codes
 * @returns Safe HTML string with styled spans
 */
export function ansiToHtml(text: string): string {
  const result: string[] = [];
  const state: AnsiState = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };

  // Regex to match ANSI escape sequences
  // Matches \x1b[...m (SGR sequences) and other escape sequences
  const ansiRegex = /\x1b\[([0-9;]*)m/g;

  let lastIndex = 0;
  let match;

  while ((match = ansiRegex.exec(text)) !== null) {
    // Get text before this escape sequence
    const textBefore = text.slice(lastIndex, match.index);

    if (textBefore) {
      // CRITICAL: Escape HTML entities BEFORE wrapping in span
      const escapedText = escapeHtml(textBefore);

      if (hasActiveStyles(state)) {
        const style = buildStyleFromState(state);
        result.push(`<span style="${style}">${escapedText}</span>`);
      } else {
        result.push(escapedText);
      }
    }

    // Parse the SGR parameters
    const paramsStr = match[1];
    const params = paramsStr
      ? paramsStr.split(';').map(p => parseInt(p, 10) || 0)
      : [0];
    parseAnsiCode(params, state);

    lastIndex = ansiRegex.lastIndex;
  }

  // Handle remaining text after last escape sequence
  const remainingText = text.slice(lastIndex);
  if (remainingText) {
    // CRITICAL: Escape HTML entities
    const escapedText = escapeHtml(remainingText);

    if (hasActiveStyles(state)) {
      const style = buildStyleFromState(state);
      result.push(`<span style="${style}">${escapedText}</span>`);
    } else {
      result.push(escapedText);
    }
  }

  return result.join('');
}

/**
 * Strip ANSI escape codes from text
 *
 * @param text - Text with ANSI escape codes
 * @returns Plain text without escape codes
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Check if text contains ANSI escape codes
 *
 * @param text - Text to check
 * @returns true if text contains ANSI codes
 */
export function hasAnsiCodes(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[/.test(text);
}
