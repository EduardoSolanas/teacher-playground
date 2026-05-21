import React from 'react';

interface ShortcutItem {
  key: string;
  label: string;
  action: () => void;
  ctrl?: boolean;
  shift?: boolean;
}

interface ShortcutsHelpProps {
  visible: boolean;
  shortcuts: ShortcutItem[];
  onClose: () => void;
}

export function ShortcutsHelp({ visible, shortcuts, onClose }: ShortcutsHelpProps) {
  if (!visible) return null;

  const grouped: Record<string, Array<{ key: string; label: string; ctrl?: boolean; shift?: boolean; action: () => void }>> = {};

  for (const s of shortcuts) {
    const isCtrl = s.ctrl || s.key.startsWith('Ctrl');
    const isDelete = s.key === 'delete' || s.key === 'backspace';
    const isEscape = s.key === 'escape';
    const isTool = !isCtrl && !isDelete && !isEscape && s.key.length === 1;

    let group = 'Tools';
    if (isTool) group = 'Tools';
    else if (isDelete) group = 'Edit';
    else if (isEscape) group = 'Navigation';
    else if (isCtrl && s.key === 'z') group = 'History';
    else if (isCtrl && (s.key === 'y' || (s.key === 'z' && s.shift))) group = 'History';
    else if (isCtrl && s.key === 'd') group = 'Edit';
    else if (isCtrl && (s.key === 'g')) group = 'Edit';
    else if (isCtrl) group = 'Z-Index';

    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(s);
  }

  const keyBadgeClasses = "inline-block px-1.5 py-0.5 bg-slate-700 rounded text-xs font-mono text-slate-300 border border-slate-600";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10001]" onClick={onClose}>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-[500px] w-[90%] max-h-[80vh] overflow-y-auto text-slate-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="m-0 text-lg font-semibold">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="bg-none border-none text-slate-400 text-[20px] cursor-pointer px-2"
          >
            &times;
          </button>
        </div>

        {Object.entries(grouped).map(([group, items]) => (
          <div key={group} className="mb-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">{group}</div>
            {items.map((item, i) => {
              const label = item.label.replace(/\([^)]*\)/, '').trim();
              const keys: string[] = [];
              if (item.ctrl) keys.push('Ctrl');
              if (item.shift) keys.push('Shift');
              keys.push(item.key.charAt(0).toUpperCase() + item.key.slice(1));

              return (
                <div key={i} className="flex justify-between items-center py-1">
                  <span className="text-sm">{label}</span>
                  <span className="flex items-center gap-0.5 ml-2">
                    {keys.map((k, ki) => (
                      <span key={ki} className={keyBadgeClasses}>{k}</span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
