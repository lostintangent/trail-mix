import { expect, test } from 'bun:test';
import { dragPanel, nudgePanel, panelSize, PANELS } from './panels.ts';

const sidebar = PANELS.sidebar;
const open = { width: 300, isCollapsed: false };
const midpoint = (sidebar.rail + sidebar.min) / 2;

test('a drag past the midpoint toward the rail collapses, and expands back to the width it had', () => {
  const collapsed = dragPanel(sidebar, open, midpoint - 1);

  expect(panelSize(sidebar, collapsed)).toBe(sidebar.rail);
  expect(nudgePanel(sidebar, collapsed, 'Enter')).toEqual(open);
  expect(dragPanel(sidebar, collapsed, midpoint)).toEqual({
    width: sidebar.min,
    isCollapsed: false,
  });
});

test('a drag or a key never leaves the panel outside its range', () => {
  expect(dragPanel(sidebar, open, sidebar.max + 200).width).toBe(sidebar.max);
  expect(dragPanel(sidebar, open, sidebar.min - 1).width).toBe(sidebar.min);
  expect(nudgePanel(sidebar, { width: sidebar.min, isCollapsed: false }, 'ArrowLeft')).toEqual({
    width: sidebar.min,
    isCollapsed: false,
  });
  expect(nudgePanel(sidebar, { width: sidebar.max, isCollapsed: false }, 'ArrowRight')).toEqual({
    width: sidebar.max,
    isCollapsed: false,
  });
});

test('from the rail, the right arrow opens the panel at the width it had', () => {
  expect(nudgePanel(sidebar, { width: 280, isCollapsed: true }, 'ArrowRight')).toEqual({
    width: 280,
    isCollapsed: false,
  });
});
