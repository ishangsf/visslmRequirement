import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
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
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
