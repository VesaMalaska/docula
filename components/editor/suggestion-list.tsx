import React, { forwardRef, useImperativeHandle, useState } from 'react'
import { cn } from '@/lib/utils'

interface SuggestionListProps {
  items: { id: string; title: string }[]
  command: (item: { id: string; title: string }) => void
}

export const SuggestionList = forwardRef((props: SuggestionListProps, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [prevItems, setPrevItems] = useState(props.items)

  if (prevItems !== props.items) {
    setPrevItems(props.items)
    setSelectedIndex(0)
  }

  const selectItem = (index: number) => {
    const item = props.items[index]
    if (item) {
      props.command(item)
    }
  }

  const upHandler = () => {
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length)
  }

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % props.items.length)
  }

  const enterHandler = () => {
    selectItem(selectedIndex)
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'ArrowUp') {
        upHandler()
        return true
      }

      if (event.key === 'ArrowDown') {
        downHandler()
        return true
      }

      if (event.key === 'Enter') {
        enterHandler()
        return true
      }

      return false
    },
  }))

  return (
    <div className="bg-popover text-popover-foreground border rounded-md shadow-md p-1 min-w-[200px] overflow-hidden">
      {props.items.length ? (
        props.items.map((item, index) => (
          <button
            className={cn(
              "w-full text-left px-2 py-1.5 text-sm rounded-sm box-border outline-none transition-colors",
              index === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
            )}
            key={item.id}
            onClick={() => selectItem(index)}
          >
            {item.title}
          </button>
        ))
      ) : (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          No results
        </div>
      )}
    </div>
  )
})

SuggestionList.displayName = 'SuggestionList'
