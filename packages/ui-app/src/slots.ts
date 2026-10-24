import * as React from 'react'
import type { ComponentType } from 'react'
import { createSlots } from '@ruobai/ui-slots'

export const slots = createSlots<ComponentType<any>>()

declare global {
  interface Window {
    __RBU__: {
      React: typeof React
      h: typeof React.createElement
      slots: typeof slots
    }
  }
}

// Client plugins receive this object and never import React themselves.
window.__RBU__ = { React, h: React.createElement, slots }
