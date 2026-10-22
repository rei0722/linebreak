import { Home } from './screens/Home';
import { RoomPage, createdHere } from './screens/Room';
import { Solo } from './screens/Solo';
import { ToastHost, usePath } from './ui';

export function App() {
  const path = usePath();
  const room = path.match(/^\/room\/([^/]+)\/?$/);
  let page;
  if (room) {
    const id = room[1].toUpperCase() === 'NEW' ? 'new' : room[1].toUpperCase();
    page = <RoomPage key={createdHere.has(id) ? 'new' : id} id={id} />;
  }
  else if (path === '/solo') page = <Solo />;
  else page = <Home />;
  return (
    <>
      {page}
      <ToastHost />
    </>
  );
}
