"use client"

import * as React from "react"
import { DirectionProvider as RadixDirectionProvider } from "@radix-ui/react-direction"

type Direction = "ltr" | "rtl"

const DirectionContext = React.createContext<Direction>("ltr")

function useDirection(): Direction {
  return React.useContext(DirectionContext)
}

function DirectionProvider({
  direction = "ltr",
  children,
}: {
  direction?: Direction
  children: React.ReactNode
}) {
  return (
    <DirectionContext.Provider value={direction}>
      <RadixDirectionProvider dir={direction}>
        {children}
      </RadixDirectionProvider>
    </DirectionContext.Provider>
  )
}

export { DirectionProvider, useDirection, type Direction }
