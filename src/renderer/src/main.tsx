import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'
import { APP_THEME_STORAGE_KEY, readInitialThemeMode } from './theme'
import type { AppThemeMode } from './theme'

const darkThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  token: {
    colorPrimary: '#7c6cff',
    colorInfo: '#60a5fa',
    colorSuccess: '#34d399',
    colorWarning: '#f2b45c',
    colorError: '#ef6b73',
    colorBgBase: '#0b0d13',
    colorBgLayout: '#090b10',
    colorBgContainer: '#151821',
    colorBgElevated: '#1b1f2a',
    colorText: '#eef1f7',
    colorTextSecondary: '#929bad',
    colorTextTertiary: '#6f798c',
    colorBorder: '#2b3040',
    colorBorderSecondary: '#242936',
    colorFillSecondary: 'rgba(255, 255, 255, 0.045)',
    colorFillTertiary: 'rgba(255, 255, 255, 0.025)',
    colorFillQuaternary: 'rgba(255, 255, 255, 0.018)',
    borderRadius: 10,
    borderRadiusSM: 8,
    borderRadiusLG: 12,
    controlHeight: 36,
    controlHeightSM: 30,
    controlHeightLG: 40,
    fontSize: 13,
    lineHeight: 1.55,
    fontFamily:
      '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
  },
  components: {
    Layout: {
      siderBg: 'transparent',
      bodyBg: '#090b10',
      headerBg: '#0e1118'
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#9aa4b6',
      itemSelectedBg: 'rgba(124, 108, 255, 0.16)',
      itemSelectedColor: '#c9c3ff',
      itemHoverBg: 'rgba(255, 255, 255, 0.055)',
      itemHoverColor: '#f4f6fb',
      itemBorderRadius: 10,
      itemHeight: 42,
      itemMarginBlock: 4,
      itemMarginInline: 0,
      itemPaddingInline: 12,
      iconMarginInlineEnd: 10
    },
    Card: {
      colorBgContainer: '#151821',
      headerBg: 'rgba(255, 255, 255, 0.018)',
      bodyPadding: 18,
      bodyPaddingSM: 14,
      headerHeight: 52,
      headerHeightSM: 44,
      headerPadding: 18,
      headerPaddingSM: 14
    },
    Form: {
      labelColor: '#cfd5e1',
      labelFontSize: 12,
      labelHeight: 22,
      itemMarginBottom: 18,
      inlineItemMarginBottom: 12,
      verticalLabelPadding: '0 0 6px',
      verticalLabelMargin: 0
    },
    Table: {
      headerBg: '#11141b',
      headerColor: '#aab3c3',
      rowHoverBg: 'rgba(124, 108, 255, 0.075)',
      rowSelectedBg: 'rgba(124, 108, 255, 0.12)',
      rowSelectedHoverBg: 'rgba(124, 108, 255, 0.17)',
      borderColor: '#252a37',
      cellPaddingBlock: 10,
      cellPaddingInline: 12,
      cellPaddingBlockMD: 9,
      cellPaddingInlineMD: 11,
      cellPaddingBlockSM: 8,
      cellPaddingInlineSM: 10,
      headerBorderRadius: 8,
      footerBg: 'transparent',
      footerColor: '#929bad'
    },
    Button: {
      defaultBg: '#191d27',
      defaultBorderColor: '#303647',
      defaultColor: '#dce1ea',
      defaultHoverBg: '#202532',
      defaultHoverColor: '#ffffff',
      defaultHoverBorderColor: '#555d73',
      defaultActiveBg: '#11151d',
      defaultActiveColor: '#ffffff',
      defaultActiveBorderColor: '#786bea',
      primaryShadow: '0 8px 22px rgba(92, 75, 255, 0.24)',
      fontWeight: 600,
      iconGap: 7,
      paddingInline: 13,
      paddingInlineSM: 10,
      paddingInlineLG: 16,
      linkHoverBg: 'rgba(124, 108, 255, 0.1)',
      textHoverBg: 'rgba(255, 255, 255, 0.055)'
    },
    Input: {
      colorBgContainer: '#10131a',
      activeBg: '#11151d',
      hoverBg: '#11151d',
      hoverBorderColor: '#555d73',
      activeBorderColor: '#786bea',
      activeShadow: '0 0 0 3px rgba(124, 108, 255, 0.14)',
      paddingInline: 11,
      paddingInlineSM: 9,
      paddingInlineLG: 13,
      paddingBlock: 7,
      paddingBlockSM: 4,
      paddingBlockLG: 9
    },
    Select: {
      colorBgContainer: '#10131a',
      optionSelectedBg: 'rgba(124, 108, 255, 0.18)',
      optionActiveBg: 'rgba(255, 255, 255, 0.055)',
      optionSelectedColor: '#dedaff',
      selectorBg: '#10131a',
      hoverBorderColor: '#555d73',
      activeBorderColor: '#786bea',
      activeOutlineColor: 'rgba(124, 108, 255, 0.14)',
      optionPadding: '7px 11px',
      optionHeight: 34
    },
    Tabs: {
      itemColor: '#929bad',
      itemHoverColor: '#d8d4ff',
      itemActiveColor: '#dedaff',
      itemSelectedColor: '#dedaff',
      inkBarColor: '#7c6cff',
      horizontalItemGutter: 24,
      horizontalItemPadding: '10px 4px 12px'
    },
    Collapse: {
      headerBg: '#12161e',
      contentBg: '#12161e',
      headerPadding: '12px 14px',
      contentPadding: '14px'
    },
    Modal: {
      contentBg: '#171b24',
      headerBg: '#171b24',
      footerBg: '#171b24',
      titleColor: '#eef1f7'
    },
    Drawer: {
      colorBgElevated: '#171b24'
    },
    Descriptions: {
      labelBg: 'rgba(255, 255, 255, 0.035)'
    }
  }
}

const lightThemeConfig = {
  algorithm: antTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#5d50c8',
    colorInfo: '#2f6eb5',
    colorSuccess: '#137a52',
    colorWarning: '#a15f00',
    colorError: '#bd3f4c',
    colorBgBase: '#f4f5f8',
    colorBgLayout: '#f4f5f8',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorText: '#1c2433',
    colorTextSecondary: '#566174',
    colorTextTertiary: '#758196',
    colorBorder: '#cfd6e1',
    colorBorderSecondary: '#e1e5eb',
    colorFillSecondary: 'rgba(93, 80, 200, 0.08)',
    colorFillTertiary: 'rgba(28, 36, 51, 0.05)',
    colorFillQuaternary: 'rgba(28, 36, 51, 0.03)',
    borderRadius: 10,
    borderRadiusSM: 8,
    borderRadiusLG: 12,
    controlHeight: 36,
    controlHeightSM: 30,
    controlHeightLG: 40,
    fontSize: 13,
    lineHeight: 1.55,
    fontFamily:
      '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
  },
  components: {
    Layout: {
      siderBg: 'transparent',
      bodyBg: '#f4f5f8',
      headerBg: '#ffffff'
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#566174',
      itemSelectedBg: 'rgba(93, 80, 200, 0.11)',
      itemSelectedColor: '#4b3eae',
      itemHoverBg: 'rgba(93, 80, 200, 0.065)',
      itemHoverColor: '#1c2433',
      itemBorderRadius: 10,
      itemHeight: 42,
      itemMarginBlock: 4,
      itemMarginInline: 0,
      itemPaddingInline: 12,
      iconMarginInlineEnd: 10
    },
    Card: {
      colorBgContainer: '#ffffff',
      headerBg: '#f8f9fb',
      bodyPadding: 18,
      bodyPaddingSM: 14,
      headerHeight: 52,
      headerHeightSM: 44,
      headerPadding: 18,
      headerPaddingSM: 14
    },
    Form: {
      labelColor: '#3c4759',
      labelFontSize: 12,
      labelHeight: 22,
      itemMarginBottom: 18,
      inlineItemMarginBottom: 12,
      verticalLabelPadding: '0 0 6px',
      verticalLabelMargin: 0
    },
    Table: {
      headerBg: '#eef1f5',
      headerColor: '#465369',
      rowHoverBg: 'rgba(93, 80, 200, 0.055)',
      rowSelectedBg: 'rgba(93, 80, 200, 0.1)',
      rowSelectedHoverBg: 'rgba(93, 80, 200, 0.14)',
      borderColor: '#d7dde6',
      cellPaddingBlock: 10,
      cellPaddingInline: 12,
      cellPaddingBlockMD: 9,
      cellPaddingInlineMD: 11,
      cellPaddingBlockSM: 8,
      cellPaddingInlineSM: 10,
      headerBorderRadius: 8,
      footerBg: 'transparent',
      footerColor: '#566174'
    },
    Button: {
      defaultBg: '#ffffff',
      defaultBorderColor: '#c6ceda',
      defaultColor: '#253044',
      defaultHoverBg: '#f6f4ff',
      defaultHoverColor: '#4b3eae',
      defaultHoverBorderColor: '#7569d2',
      defaultActiveBg: '#eeecfb',
      defaultActiveColor: '#4b3eae',
      defaultActiveBorderColor: '#5d50c8',
      primaryShadow: '0 8px 22px rgba(93, 80, 200, 0.2)',
      fontWeight: 600,
      iconGap: 7,
      paddingInline: 13,
      paddingInlineSM: 10,
      paddingInlineLG: 16,
      linkHoverBg: 'rgba(93, 80, 200, 0.08)',
      textHoverBg: 'rgba(93, 80, 200, 0.065)'
    },
    Input: {
      colorBgContainer: '#ffffff',
      activeBg: '#ffffff',
      hoverBg: '#ffffff',
      hoverBorderColor: '#7569d2',
      activeBorderColor: '#5d50c8',
      activeShadow: '0 0 0 3px rgba(93, 80, 200, 0.14)',
      paddingInline: 11,
      paddingInlineSM: 9,
      paddingInlineLG: 13,
      paddingBlock: 7,
      paddingBlockSM: 4,
      paddingBlockLG: 9
    },
    Select: {
      colorBgContainer: '#ffffff',
      optionSelectedBg: 'rgba(93, 80, 200, 0.12)',
      optionActiveBg: 'rgba(93, 80, 200, 0.065)',
      optionSelectedColor: '#4b3eae',
      selectorBg: '#ffffff',
      hoverBorderColor: '#7569d2',
      activeBorderColor: '#5d50c8',
      activeOutlineColor: 'rgba(93, 80, 200, 0.14)',
      optionPadding: '7px 11px',
      optionHeight: 34
    },
    Tabs: {
      itemColor: '#566174',
      itemHoverColor: '#4b3eae',
      itemActiveColor: '#4b3eae',
      itemSelectedColor: '#4b3eae',
      inkBarColor: '#5d50c8',
      horizontalItemGutter: 24,
      horizontalItemPadding: '10px 4px 12px'
    },
    Collapse: {
      headerBg: '#f3f5f8',
      contentBg: '#ffffff',
      headerPadding: '12px 14px',
      contentPadding: '14px'
    },
    Modal: {
      contentBg: '#ffffff',
      headerBg: '#ffffff',
      footerBg: '#ffffff',
      titleColor: '#211e2b'
    },
    Drawer: {
      colorBgElevated: '#ffffff'
    },
    Descriptions: {
      labelBg: '#eef1f5'
    }
  }
}

const initialThemeMode = readInitialThemeMode()
document.documentElement.dataset.theme = initialThemeMode

function RendererRoot({ themeMode, onThemeModeChange }: { themeMode: AppThemeMode; onThemeModeChange: (next: AppThemeMode) => void }): React.JSX.Element {
  const themeConfig = themeMode === 'dark' ? darkThemeConfig : lightThemeConfig

  React.useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    document.documentElement.style.colorScheme = themeMode
    try {
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, themeMode)
    } catch {
      // The theme still applies when storage is unavailable.
    }
  }, [themeMode])

  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <App themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
    </ConfigProvider>
  )
}

function Root(): React.JSX.Element {
  const [themeMode, setThemeMode] = React.useState<AppThemeMode>(initialThemeMode)

  return (
    <RendererRoot
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
    />
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
