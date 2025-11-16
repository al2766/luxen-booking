// lib/bookingTypes.ts

export type SizeId = 'xs' | 's' | 'm' | 'l' | 'xl';

export type RoomTypeId =
  | 'bedroom'
  | 'living'
  | 'open-plan'
  | 'storage'
  | 'hallway'
  | 'office'
  | 'meeting'
  | 'other';

export type RoomItem = {
  typeId: RoomTypeId;
  sizeId: SizeId;
  count: number;
};

export type WetRoomItem = {
  sizeId: SizeId;
  count: number;
};

export const SIZE_LABELS: Record<SizeId, string> = {
  xs: 'XS',
  s: 'S',
  m: 'M',
  l: 'L',
  xl: 'XL',
};

export const ROOM_TYPE_LABELS: Record<RoomTypeId, string> = {
  bedroom: 'Bedroom',
  living: 'Living room',
  'open-plan': 'Open-plan / living',
  storage: 'Storage / cupboard',
  hallway: 'Hallway / landing',
  office: 'Office',
  meeting: 'Meeting room',
  other: 'Other',
};

/**
 * Group array of { typeId, sizeId } into counts:
 * [{ typeId: 'bedroom', sizeId: 'm' }, ...] → [{ typeId: 'bedroom', sizeId: 'm', count: 3 }]
 */
export const groupRoomSelections = (
  items: { typeId: RoomTypeId; sizeId: SizeId }[]
): RoomItem[] => {
  const grouped: RoomItem[] = [];
  for (const item of items) {
    const existing = grouped.find(
      (g) => g.typeId === item.typeId && g.sizeId === item.sizeId
    );
    if (existing) {
      existing.count += 1;
    } else {
      grouped.push({ ...item, count: 1 });
    }
  }
  return grouped;
};

/**
 * Simple helper for single wet-room input: size + count → array
 */
export const oneWetRoomItem = (
  sizeId: SizeId | '',
  count: number
): WetRoomItem[] => {
  if (!sizeId || !count) return [];
  return [{ sizeId, count }];
};

export const formatRoomItems = (items?: RoomItem[]): string => {
  if (!items || items.length === 0) return 'None';
  return items
    .map((r) => {
      const labelType = ROOM_TYPE_LABELS[r.typeId] ?? r.typeId;
      const labelSize = SIZE_LABELS[r.sizeId] ?? r.sizeId.toUpperCase();
      return `${r.count}× ${labelType} (${labelSize})`;
    })
    .join(', ');
};

export const formatWetItems = (
  items?: WetRoomItem[],
  labelSingular = 'Room'
): string => {
  if (!items || items.length === 0) return 'None';
  return items
    .map((w) => {
      const labelSize = SIZE_LABELS[w.sizeId] ?? w.sizeId.toUpperCase();
      return `${w.count}× ${labelSingular} (${labelSize})`;
    })
    .join(', ');
};

export const formatDuration = (minutes: number): string => {
  if (!minutes || minutes <= 0) return '—';
  const hours = Math.round((minutes / 60) * 10) / 10;
  if (hours < 1) return `${minutes} min`;
  return `${hours} hrs`;
};
