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
      'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'PICTURE', 'SOURCE', 'IMG'
    ])
    const findLocalImage = (source: string): RecordDetail['images'][number] | undefined => {
      const normalizedSource = (() => {
        try { return decodeURIComponent(source) } catch { return source }
      })()
      const tokenMatch = /^visslm-asset:\/\/([a-f0-9]{64})\//i.exec(source)
      return images.find((image) => Boolean(
        tokenMatch && image.sha256.toLowerCase() === tokenMatch[1].toLowerCase() ||
        image.sourceUrl.includes(source) ||
        image.sourceUrl.includes(normalizedSource) ||
        source.startsWith('data:image/') && image.sourceUrl.startsWith('inline:data-uri')
      ))
    }
    const replaceSrcset = (value: string): string => value
      .split(',')
      .map((candidate) => {
        const match = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate)
        if (!match) return ''
        const local = findLocalImage(match[2])?.assetUrl
        return local ? `${match[1]}${local}${match[3]}` : ''
      })
      .filter(Boolean)
      .join(', ')
    for (const element of [...document.body.querySelectorAll('*')]) {
      if (!allowedTags.has(element.tagName)) {
        element.replaceWith(...element.childNodes)
        continue
      }
      if (element.tagName === 'IMG' || element.tagName === 'SOURCE') {
        const source = element.getAttribute('src') ?? ''
        const alt = element.getAttribute('alt') ?? '描述图片'
        const srcset = element.getAttribute('srcset') ?? ''
        const localImage = findLocalImage(source) ?? (srcset ? findLocalImage(srcset.split(',')[0]?.trim().split(/\s+/, 1)[0] ?? '') : undefined)
        for (const attribute of [...element.attributes]) {
          element.removeAttribute(attribute.name)
        }
        const localSource = localImage?.assetUrl
        const localSrcset = srcset ? replaceSrcset(srcset) : ''
        if (localSource || localSrcset) {
          if (localSource) element.setAttribute('src', localSource)
          if (localSrcset) element.setAttribute('srcset', localSrcset)
          if (element.tagName === 'IMG') {
            element.setAttribute('alt', alt)
            element.setAttribute('loading', 'lazy')
          }
        } else {
          if (element.tagName === 'SOURCE') element.remove()
          else element.replaceWith(document.createTextNode(`[图片暂未同步：${alt}]`))
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
