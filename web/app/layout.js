import './globals.css';
import 'katex/dist/katex.min.css';

export const metadata = {
  title: 'Lana',
  description: 'Chat with your Lana assistant :3',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
