import "./styles.css";
import BrandMark from "./brand-mark.jsx";
export const metadata = {
  title: {
    default: "Wittle Agents — A clearer website starts here",
    template: "%s · Wittle Agents",
  },
  description:
    "Scope a website audit for free in Wittle Rooms. Agree the pages, review the quote, then decide whether to pay.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <a className="brand" href="/" aria-label="Wittle Agents home">
            <BrandMark size={48} />
            <span>wittle agents</span>
          </a>
          <nav aria-label="Main navigation">
            <a href="/#sample">Sample audit</a>
            <a href="/live">Activity</a>
            <a className="nav-start" href="/start">
              Get an audit <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </header>
        {children}
        <footer>
          <a className="company" href="https://wittlelabs.ai" rel="noreferrer">
            <BrandMark size={40} />
            <span>wittle labs</span>
          </a>
          <a href="/live">Evidence & status</a>
        </footer>
      </body>
    </html>
  );
}
