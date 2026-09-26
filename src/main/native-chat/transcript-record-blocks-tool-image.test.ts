import { describe, expect, it } from 'vitest'
import { claudeContentBlocks } from './transcript-record-blocks'

// Agent-taken screenshots ride inside tool_result content as Anthropic image
// blocks. The text output still flattens to the tool-result block; each image
// part additionally promotes to an image-ref so chat can render it.
const TOOL_RESULT_WITH_SCREENSHOT = [
  {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: [
      { type: 'text', text: 'screenshot taken' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
      }
    ]
  }
]

describe('tool_result image promotion', () => {
  it('emits an image-ref alongside the tool-result text', () => {
    expect(claudeContentBlocks(TOOL_RESULT_WITH_SCREENSHOT)).toEqual([
      { type: 'tool-result', output: 'screenshot taken' },
      { type: 'image-ref', url: 'data:image/png;base64,iVBORw0KGgo=' }
    ])
  })

  it('keeps url-sourced images as url refs', () => {
    const blocks = claudeContentBlocks([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        content: [{ type: 'image', source: { type: 'url', url: 'https://x.test/shot.png' } }]
      }
    ])
    expect(blocks).toEqual([
      { type: 'tool-result', output: '' },
      { type: 'image-ref', url: 'https://x.test/shot.png' }
    ])
  })

  it('leaves text-only tool results unchanged', () => {
    expect(
      claudeContentBlocks([{ type: 'tool_result', tool_use_id: 'x', content: 'done' }])
    ).toEqual([{ type: 'tool-result', output: 'done' }])
  })

  it('drops base64 parts whose mime is not a raster image', () => {
    const blocks = claudeContentBlocks([
      {
        type: 'tool_result',
        tool_use_id: 'x',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' }
          }
        ]
      }
    ])
    expect(blocks).toEqual([{ type: 'tool-result', output: '' }])
  })

  it('still drops user-prompt base64 images without url/path (companion rows carry them)', () => {
    const blocks = claudeContentBlocks([
      { type: 'text', text: 'look [Image #1]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ])
    expect(blocks).toEqual([{ type: 'text', text: 'look [Image #1]' }])
  })
})
