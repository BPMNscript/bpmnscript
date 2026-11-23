import { describe, expect, test } from 'vitest';
import { THEME_TOKENS, themeData, type ThemeColors } from '../src/theme';

const colors = Object.fromEntries(
  THEME_TOKENS.map((t, i) => [
    t,
    `#${(0x101010 * (i + 1)).toString(16).padStart(6, '0').slice(-6)}`,
  ]),
) as ThemeColors;

describe('theme', () => {
  test('syntax colours come from the token colours, by the token types the Monarch grammar emits', () => {
    const { rules } = themeData(colors, false);
    const rule = (token: string) => rules.find((r) => r.token === token);
    expect(rule('keyword')).toEqual({
      token: 'keyword',
      foreground: colors['syn-keyword'].slice(1),
      fontStyle: 'bold',
    });
    expect(rule('QUOTED_NAME')?.foreground).toBe(colors['syn-name'].slice(1));
    expect(rule('RAW_TEMPLATE')?.foreground).toBe(
      colors['syn-template'].slice(1),
    );
    expect(rule('FENCED_SCRIPT')?.foreground).toBe(
      colors['syn-script'].slice(1),
    );
    expect(rule('comment')).toMatchObject({
      foreground: colors.mute.slice(1),
      fontStyle: 'italic',
    });
  });

  test('every widget colour is set from the tokens, so nothing falls back to the base theme', () => {
    const light = themeData(colors, false);
    expect(light.base).toBe('vs');
    expect(light.inherit).toBe(false);
    expect(light.colors['editor.background']).toBe(colors.panel);
    expect(light.colors['editor.selectionBackground']).toBe(
      `${colors.accent}40`,
    );
    expect(light.colors['menu.background']).toBe(colors.raised);
    expect(light.colors['peekView.border']).toBe(colors.accent);
    expect(themeData(colors, true).base).toBe('vs-dark');
    for (const [name, value] of Object.entries(light.colors))
      expect(value, name).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  });
});
