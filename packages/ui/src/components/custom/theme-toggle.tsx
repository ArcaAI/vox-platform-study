"use client"

import { useState, useEffect } from "react"
import { IconSun, IconMoon } from "@tabler/icons-react"
import { Button } from "../shadcn/button"
import { cn } from "../../lib/utils"

const STORAGE_KEY = "arcaai-theme"

export interface ThemeToggleProps {
  className?: string
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    const prefersDark =
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches)

    setDark(prefersDark)
    document.documentElement.classList.toggle("dark", prefersDark)
  }, [])

  function toggle() {
    setDark((prev) => {
      const next = !prev
      document.documentElement.classList.toggle("dark", next)
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light")
      return next
    })
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn("relative", className)}
    >
      <IconSun className="size-4 rotate-0 scale-100 transition-transform dark:rotate-90 dark:scale-0" />
      <IconMoon className="absolute size-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
    </Button>
  )
}
