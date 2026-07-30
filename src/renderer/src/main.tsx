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
          colorBgBase: '#0b0d13',
          colorBgLayout: '#090b10',
          colorBgContainer: '#151821',
          colorBgElevated: '#1b1f2a',
          colorText: '#eef1f7',
          colorTextSecondary: '#929bad',
          colorBorder: '#2b3040',
          colorBorderSecondary: '#242936',
          borderRadius: 12,
          controlHeight: 34,
          fontFamily:
            '"Inter", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
        },
        components: {
          Layout: { siderBg: 'transparent', bodyBg: '#090b10', headerBg: '#0e1118' },
          Menu: {
            itemBg: 'transparent',
            itemColor: '#9aa4b6',
            itemSelectedBg: 'rgba(124, 108, 255, 0.16)',
            itemSelectedColor: '#c9c3ff',
            itemHoverBg: 'rgba(255, 255, 255, 0.055)',
            itemHoverColor: '#f4f6fb',
            itemBorderRadius: 11
          },
          Card: {
            colorBgContainer: '#151821',
            headerBg: 'rgba(255, 255, 255, 0.018)'
          },
          Table: {
            headerBg: '#11141b',
            rowHoverBg: 'rgba(124, 108, 255, 0.075)',
            borderColor: '#252a37'
          },
          Button: {
            defaultBg: '#191d27',
            defaultBorderColor: '#303647',
            defaultColor: '#dce1ea',
            primaryShadow: '0 8px 22px rgba(92, 75, 255, 0.24)'
          },
          Input: {
            colorBgContainer: '#10131a',
            activeBg: '#11151d',
            hoverBg: '#11151d'
          },
          Select: {
            colorBgContainer: '#10131a',
            optionSelectedBg: 'rgba(124, 108, 255, 0.18)'
          }
        }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
