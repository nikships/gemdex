import { ToastProvider } from "./context/ToastContext";
import { useReveal } from "./hooks/useReveal";
import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { QuoteBand } from "./components/QuoteBand";
import { Workflow } from "./components/Workflow";
import { Features } from "./components/Features";
import { HowItWorks } from "./components/HowItWorks";
import { Tools } from "./components/Tools";
import { Quickstart } from "./components/Quickstart";
import { Multimodal } from "./components/Multimodal";
import { DesktopApp } from "./components/DesktopApp";
import { Privacy } from "./components/Privacy";
import { Roadmap } from "./components/Roadmap";
import { FinalCta } from "./components/FinalCta";
import { Footer } from "./components/Footer";

export default function App() {
    useReveal();

    return (
        <ToastProvider>
            <Nav />
            <main id="top">
                <Hero />
                <div className="wrap">
                    <div className="divider" />
                </div>
                <QuoteBand />
                <Workflow />
                <Features />
                <HowItWorks />
                <Tools />
                <Quickstart />
                <Multimodal />
                <DesktopApp />
                <Privacy />
                <Roadmap />
                <FinalCta />
            </main>
            <Footer />
        </ToastProvider>
    );
}
