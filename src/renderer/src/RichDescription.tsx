import { Typography } from 'antd'
import React, { useMemo } from 'react'
import type { RecordDetail } from '../../shared/types'

const { Text } = Typography

export function RichDescription({
  html,
  images
}: {
  html: string
  images: RecordDetail['images']
}): React.JSX.Element {
  const safeHtml = useMemo(() => {
    if (!html) return ''
    const document = new DOMParser().parseFromString(html, 'text/html')
    document
      .querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button,svg')
      .forEach((element) => element.remove())

    const allowedTags = new Set([
      'P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U',
      'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
      'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'IMG'
    ])
    for (const element of [...document.body.querySelectorAll('*')]) {
      if (!allowedTags.has(element.tagName)) {
        element.replaceWith(...element.childNodes)
        continue
      }
      if (element.tagName === 'IMG') {
        const source = element.getAttribute('src') ?? ''
        const alt = element.getAttribute('alt') ?? '描述图片'
        const normalizedSource = (() => {
          try {
            return decodeURIComponent(source)
          } catch {
            return source
          }
        })()
        const localImage = images.find((image) =>
          Boolean(
            image.dataUri &&
            (
              image.sourceUrl.includes(source) ||
              image.sourceUrl.includes(normalizedSource) ||
              (source.startsWith('data:image/') && image.sourceUrl === 'inline:data-uri')
            )
          )
        )
        for (const attribute of [...element.attributes]) {
          element.removeAttribute(attribute.name)
        }
        if (localImage?.dataUri) {
          element.setAttribute('src', localImage.dataUri)
          element.setAttribute('alt', alt)
          element.setAttribute('loading', 'lazy')
        } else {
          element.replaceWith(document.createTextNode(`[图片暂未同步：${alt}]`))
        }
      } else {
        for (const attribute of [...element.attributes]) {
          element.removeAttribute(attribute.name)
        }
      }
    }
    return document.body.innerHTML
  }, [html, images])

  if (!safeHtml) return <Text type="secondary">暂无描述</Text>
  return (
    <div
      className="rich-description"
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
}
