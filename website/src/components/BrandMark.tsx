/** Watercolor logo mark (repo raster art). Used in nav + footer. */
export function BrandMark({ className = "mark" }: { className?: string }) {
    return <img className={className} src="./brand/logo-mark-256.png" alt="" width={34} height={34} aria-hidden="true" />;
}
