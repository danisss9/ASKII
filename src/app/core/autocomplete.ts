import {
  AutocompleteSuggestion,
  ClipboardHistoryItem,
  ModelProfile,
  PromptRecipe,
  SlashCommand,
} from './models';

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    command: '/model',
    label: '/model',
    description: 'Hot-switch between recently used providers & models without opening Setup',
    kaomoji: '⚡',
  },
  {
    command: '/autodo',
    label: '/autodo',
    description: 'Toggle ASKII Auto Do autonomous OS action mode on or off',
    kaomoji: '(ง •̀_•́)ง',
  },
  {
    command: '/agent',
    label: '/agent',
    description: 'Configure ASKII Do permissions, Auto Do mode, and MCP servers',
    kaomoji: 'ᕦ(ò_óˇ)ᕤ',
  },
  {
    command: '/snip',
    label: '/snip',
    description: 'Capture your screen as a vision attachment (add "window" for active window)',
    kaomoji: '(◉_◉)📷',
  },
  {
    command: '/setup',
    label: '/setup',
    description: 'Morph into setup to configure LLM connectors and shortcuts',
    kaomoji: '(⌐■_■)',
  },
  {
    command: '/provider',
    label: '/provider',
    description: 'Switch active LLM provider or model',
    kaomoji: '(☞ﾟヮﾟ)☞',
  },
  {
    command: '/shortcut',
    label: '/shortcut',
    description: 'Customize global toggle & selection shortcuts',
    kaomoji: 'ヾ(⌐■_■)ノ♪',
  },
  {
    command: '/history',
    label: '/history',
    description: 'Search and reopen archived receipt slips from local SQLite',
    kaomoji: '(◕‿◕)',
  },
  {
    command: '/memory',
    label: '/memory',
    description: 'View or manage ASKII persistent personal memories',
    kaomoji: '(｡◕‿◕｡)',
  },
  {
    command: '/remember',
    label: '/remember',
    description: 'Save a personal preference or fact (e.g. /remember I prefer PowerShell 7)',
    kaomoji: '(•‿•)✎',
  },
  {
    command: '/reindex',
    label: '/reindex',
    description: 'Refresh the Windows Start Menu instant app launcher index',
    kaomoji: '↻',
  },
  {
    command: '/pin',
    label: '/pin',
    description: 'Pin or unpin ASKII so it stays visible when switching windows',
    kaomoji: '(•‿•)',
  },
  {
    command: '/clear',
    label: '/clear',
    description: 'Tear off the print paper and clear attachments',
    kaomoji: '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧',
  },
  {
    command: '/hide',
    label: '/hide',
    description: 'Hide ASKII back into the Windows system tray',
    kaomoji: '(￣▽￣)ノ',
  },
  {
    command: '/quit',
    label: '/quit',
    description: 'Exit ASKII completely',
    kaomoji: '┬─┬ ノ( ゜-゜ノ)',
  },
];

export const CONTEXT_MENTIONS: readonly {
  token: string;
  label: string;
  description: string;
  badge: string;
}[] = [
  {
    token: '@clip',
    label: '@clip',
    description: 'Attach current Windows clipboard text or image',
    badge: 'CLIP',
  },
  {
    token: '@window',
    label: '@window',
    description: 'Attach active foreground window title & app info',
    badge: 'WIN',
  },
  {
    token: '@screen',
    label: '@screen',
    description: 'Capture full display screenshot for vision analysis',
    badge: 'SCRN',
  },
  {
    token: '@winscreen',
    label: '@winscreen',
    description: 'Capture screenshot of the active target window',
    badge: 'WIN📷',
  },
];

export interface AutocompleteResult {
  ghostSuffix: string;
  ghostFullValue: string;
  suggestions: AutocompleteSuggestion[];
  showDropdown: boolean;
}

export function computeAutocomplete(
  input: string,
  promptHistory: readonly string[],
  recipes: readonly PromptRecipe[] = [],
  maxItems = 7,
  recentModels: readonly ModelProfile[] = [],
  clipboardHistory: readonly ClipboardHistoryItem[] = [],
): AutocompleteResult {
  const raw = input;
  const trimmedStart = raw.trimStart();

  if (!trimmedStart) {
    return {
      ghostSuffix: '',
      ghostFullValue: '',
      suggestions: [],
      showDropdown: false,
    };
  }

  // Inline /model quick switcher
  if (trimmedStart.toLowerCase().startsWith('/model ')) {
    const filter = trimmedStart.slice('/model '.length).trim().toLowerCase();
    const matches: AutocompleteSuggestion[] = recentModels
      .filter(
        (m) =>
          !filter ||
          m.model.toLowerCase().includes(filter) ||
          m.provider.toLowerCase().includes(filter),
      )
      .slice(0, maxItems)
      .map((m) => ({
        kind: 'model' as const,
        value: `/model ${m.provider}/${m.model}`,
        label: m.model,
        description: `Switch active model to ${m.provider} / ${m.model}`,
        badge: m.provider.toUpperCase(),
        modelProfile: m,
      }));
    return {
      ghostSuffix: '',
      ghostFullValue: '',
      suggestions: matches,
      showDropdown: matches.length > 0,
    };
  }

  // Context @mention mode at the trailing token (including @clip:N history picker)
  const mentionMatch = /(?:^|\s)(@[a-zA-Z0-9:]*)$/.exec(raw);
  if (mentionMatch) {
    const token = mentionMatch[1].toLowerCase();
    const prefixBeforeToken = raw.slice(0, raw.length - mentionMatch[1].length);

    if (token.startsWith('@clip:') && clipboardHistory.length > 0) {
      const idxNeedle = token.slice('@clip:'.length);
      const ringMatches: AutocompleteSuggestion[] = clipboardHistory
        .filter((item) => !idxNeedle || String(item.index).startsWith(idxNeedle))
        .slice(0, maxItems)
        .map((item) => ({
          kind: 'mention',
          value: `@clip:${item.index}`,
          label: `@clip:${item.index} · ${item.preview}`,
          description: item.sourceApp ? `Copied from ${item.sourceApp}` : 'Clipboard history item',
          badge: `#${item.index}`,
        }));
      return {
        ghostSuffix: '',
        ghostFullValue: '',
        suggestions: ringMatches,
        showDropdown: ringMatches.length > 0,
      };
    }

    const matches: AutocompleteSuggestion[] = CONTEXT_MENTIONS.filter(
      (m) =>
        m.token.startsWith(token) ||
        (token.length > 1 && m.description.toLowerCase().includes(token.slice(1))),
    )
      .slice(0, maxItems)
      .map((m) => ({
        kind: 'mention',
        value: m.token,
        label: m.label,
        description: m.description,
        badge: m.badge,
      }));

    if (token === '@clip' && clipboardHistory.length > 0) {
      for (const item of clipboardHistory.slice(0, 3)) {
        matches.push({
          kind: 'mention',
          value: `@clip:${item.index}`,
          label: `@clip:${item.index} · ${item.preview}`,
          description: item.sourceApp ? `From ${item.sourceApp}` : 'Recent clipboard history',
          badge: `#${item.index}`,
        });
      }
    }

    const top = matches.find((m) => m.value.startsWith(token));
    const ghostSuffix = top && top.value.length > token.length ? top.value.slice(token.length) : '';
    return {
      ghostSuffix,
      ghostFullValue: top ? `${prefixBeforeToken}${top.value} ` : '',
      suggestions: matches.slice(0, maxItems),
      showDropdown: matches.length > 0,
    };
  }

  // Slash-command & prompt recipe mode
  if (trimmedStart.startsWith('/') && !trimmedStart.includes(' ')) {
    const needle = trimmedStart.toLowerCase();

    const recipeSuggestions: AutocompleteSuggestion[] = recipes
      .filter(
        (r) =>
          r.command.toLowerCase().startsWith(needle) ||
          r.description.toLowerCase().includes(needle.slice(1)),
      )
      .map((r) => ({
        kind: 'recipe' as const,
        value: r.command,
        label: r.label,
        description: r.description,
        badge: 'RECIPE',
      }));

    const cmdSuggestions: AutocompleteSuggestion[] = SLASH_COMMANDS.filter(
      (cmd) =>
        cmd.command.startsWith(needle) ||
        cmd.description.toLowerCase().includes(needle.slice(1)),
    ).map((cmd) => ({
      kind: 'command' as const,
      value: cmd.command,
      label: cmd.label,
      description: cmd.description,
      badge: cmd.kaomoji,
    }));

    const allItems = [...recipeSuggestions, ...cmdSuggestions];
    allItems.sort((a, b) => {
      const aPrefix = a.value.toLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.value.toLowerCase().startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix;
    });
    const combined = allItems.slice(0, maxItems);
    const prefixMatch = combined.find((m) => m.value.toLowerCase().startsWith(needle));
    const ghostSuffix =
      prefixMatch && prefixMatch.value.length > trimmedStart.length
        ? prefixMatch.value.slice(trimmedStart.length)
        : '';

    return {
      ghostSuffix,
      ghostFullValue: prefixMatch ? prefixMatch.value : '',
      suggestions: combined,
      showDropdown: combined.length > 0,
    };
  }

  // Prompt history prefix & fuzzy suggestions
  const lower = raw.toLowerCase();
  const prefixMatches: string[] = [];
  const containsMatches: string[] = [];

  for (const item of promptHistory) {
    const itemLower = item.toLowerCase();
    if (itemLower === lower) {
      continue;
    }
    if (itemLower.startsWith(lower)) {
      prefixMatches.push(item);
    } else if (lower.length >= 2 && itemLower.includes(lower)) {
      containsMatches.push(item);
    }
  }

  const ordered = [...prefixMatches, ...containsMatches].slice(0, maxItems);
  const topPrefix = prefixMatches[0];
  const ghostSuffix = topPrefix ? topPrefix.slice(raw.length) : '';

  const suggestions: AutocompleteSuggestion[] = ordered.map((text) => ({
    kind: 'history',
    value: text,
    label: text,
    description: 'Recent prompt · Tab to complete',
    badge: '↺',
  }));

  return {
    ghostSuffix,
    ghostFullValue: topPrefix ?? '',
    suggestions,
    showDropdown: suggestions.length > 0 && lower.length >= 2,
  };
}
