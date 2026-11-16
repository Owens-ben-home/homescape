import { friendlyName } from '@/ha/derive'
import type { HassEntity } from '@/ha/types'
import { bindingsOf } from '@/model/bindings'
import { CATALOG, GROUP_LABEL } from '@/model/catalog'
import type { Item } from '@/model/types'
import { lower } from '@/i18n'
import { itemName } from './Bindings'

/** Lower case without accents, so "lamba" finds "Lâmba" and "cafe" finds "Café"; the dotless i matches i */
export const fold = (text: string) =>
  lower(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\u0131/g, 'i')

/** What a search matches in an item: its name, kind, group, and the ids and names of its bound entities (shared with the native bridge) */
export function itemSearchText(item: Item, entities: Record<string, HassEntity>) {
  const ids = bindingsOf(item)
  return [itemName(item, item.entityId ? entities[item.entityId] : undefined), CATALOG[item.kind].label, GROUP_LABEL[CATALOG[item.kind].group], ...ids, ...ids.map((id) => friendlyName(entities[id]))].join(' ')
}
