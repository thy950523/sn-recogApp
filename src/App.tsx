import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import DesktopView from './pages/DesktopView'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/desktop" element={<DesktopView />} />
    </Routes>
  )
}
