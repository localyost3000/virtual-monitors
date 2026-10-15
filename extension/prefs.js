// Preferences window (Adwaita): default layout, panel min width, debug
// toggle, read-only layout list, editable keybindings.
import Adw from 'gi://Adw'
import Gdk from 'gi://Gdk'
import Gtk from 'gi://Gtk'
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

import { LAYOUTS } from './layout.js'

const LAYOUT_NAMES = Object.keys(LAYOUTS)

const KEYBINDINGS = [
  ['toggle-active', 'Suspend/resume (failsafe)'],
  ['layout-single', 'Layout: single'],
  ['layout-dual', 'Layout: dual'],
  ['layout-theater', 'Layout: theater (25/50/25)'],
  ['layout-thirds', 'Layout: thirds'],
  ['layout-mainside', 'Layout: main + side (70/30)'],
  ['layout-dynamic', 'Layout: dynamic (build splits with hotkeys)'],
  ['window-left', 'Move window to previous region'],
  ['window-right', 'Move window to next region'],
  ['swap-left', 'Swap window with previous region'],
  ['swap-right', 'Swap window with next region'],
  ['grow-region', 'Grow focused region'],
  ['shrink-region', 'Shrink focused region'],
  ['select-prev', 'Select previous region (dynamic)'],
  ['select-next', 'Select next region (dynamic)'],
  ['split-region', 'Split selected region (dynamic)'],
  ['close-region', 'Close selected region (dynamic)'],
]

const MODIFIER_KEYVALS = new Set([
  Gdk.KEY_Shift_L,
  Gdk.KEY_Shift_R,
  Gdk.KEY_Control_L,
  Gdk.KEY_Control_R,
  Gdk.KEY_Alt_L,
  Gdk.KEY_Alt_R,
  Gdk.KEY_Super_L,
  Gdk.KEY_Super_R,
  Gdk.KEY_Meta_L,
  Gdk.KEY_Meta_R,
  Gdk.KEY_Hyper_L,
  Gdk.KEY_Hyper_R,
  Gdk.KEY_ISO_Level3_Shift,
  Gdk.KEY_Caps_Lock,
])

export default class VirtualMonitorsPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings()
    window.set_default_size(520, 720)

    const page = new Adw.PreferencesPage()

    const general = new Adw.PreferencesGroup({ title: 'General' })
    const layoutRow = new Adw.ComboRow({
      title: 'Default layout',
      subtitle: 'Used until a workspace is switched by hotkey',
      model: Gtk.StringList.new(LAYOUT_NAMES),
    })
    layoutRow.selected = Math.max(0, LAYOUT_NAMES.indexOf(settings.get_string('default-layout')))
    layoutRow.connect('notify::selected', () =>
      settings.set_string('default-layout', LAYOUT_NAMES[layoutRow.selected]),
    )
    general.add(layoutRow)

    const debugRow = new Adw.SwitchRow({
      title: 'Debug logging',
      subtitle: 'Verbose per-window events in the shell log',
    })
    settings.bind('debug', debugRow, 'active', 0)
    general.add(debugRow)

    const fakeRow = new Adw.SwitchRow({
      title: 'Region panels via fake monitors',
      subtitle:
        'dash-to-panel renders one panel per region (experimental, one physical display only)',
    })
    settings.bind('fake-monitors', fakeRow, 'active', 0)
    general.add(fakeRow)

    const minRow = new Adw.SpinRow({
      title: 'Minimum region width for a panel',
      subtitle: 'Narrower regions get no panel (0 = every region)',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 0.5,
        step_increment: 0.05,
        page_increment: 0.05,
      }),
      digits: 2,
    })
    settings.bind('fake-min-region-fraction', minRow, 'value', 0)
    general.add(minRow)
    page.add(general)

    const layouts = new Adw.PreferencesGroup({
      title: 'Layouts',
      description: 'Column width fractions of the monitor',
    })
    for (const name of LAYOUT_NAMES) {
      const subtitle =
        name === 'dynamic'
          ? 'Starts as one region; build splits with the select/split/close hotkeys'
          : LAYOUTS[name].map((f) => `${Math.round(f * 100)}%`).join(' | ')
      layouts.add(new Adw.ActionRow({ title: name, subtitle }))
    }
    page.add(layouts)

    const keys = new Adw.PreferencesGroup({
      title: 'Keybindings',
      description: 'Click a binding and press the new keys. Esc cancels.',
    })
    for (const [key, label] of KEYBINDINGS) {
      keys.add(this._keyRow(settings, key, label))
    }
    page.add(keys)

    window.add(page)
  }

  _keyRow(settings, key, label) {
    const row = new Adw.ActionRow({ title: label })
    const btn = new Gtk.Button({ valign: Gtk.Align.CENTER })
    const updateLabel = () => btn.set_label(settings.get_strv(key)[0] ?? 'Disabled')
    updateLabel()
    btn.connect('clicked', () => {
      btn.set_label('Press keys…')
      const ctl = new Gtk.EventControllerKey()
      btn.add_controller(ctl)
      ctl.connect('key-pressed', (_c, keyval, _kc, state) => {
        if (keyval === Gdk.KEY_Escape) {
          btn.remove_controller(ctl)
          updateLabel()
          return Gdk.EVENT_STOP
        }
        if (MODIFIER_KEYVALS.has(keyval)) {
          return Gdk.EVENT_PROPAGATE
        } // bare modifier, keep listening
        const mask = state & Gtk.accelerator_get_default_mod_mask()
        const accel = Gtk.accelerator_name(keyval, mask)
        settings.set_strv(key, [accel])
        btn.remove_controller(ctl)
        updateLabel()
        return Gdk.EVENT_STOP
      })
    })
    row.add_suffix(btn)
    return row
  }
}
