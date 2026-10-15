import type { CSSProperties } from "react";
import type { Community } from "../api";
import { communityTile } from "../lib/communityIcon";
import Avatar from "./Avatar";

type TileSource = Pick<Community, "name" | "iconUrl" | "iconText" | "iconColor">;

/**
 * The class and style a community's tile needs on its outer element (the rail's link, or the
 * settings preview): a colour of its own choosing reaches the CSS as custom properties, so it keeps
 * that colour when hovered or selected. A picture needs neither: it fills the tile.
 */
export function tileProps(community: TileSource): { className: string; style: CSSProperties | undefined } {
  const tile = communityTile(community);
  if (community.iconUrl || !tile.colours) return { className: "", style: undefined };
  return {
    className: " rail-tile-coloured",
    style: { "--tile-bg": tile.colours.background, "--tile-fg": tile.colours.text } as CSSProperties,
  };
}

/** What goes inside the tile: the picture, or the letters. */
export function TileFace({ community }: { community: TileSource }) {
  if (community.iconUrl) {
    // Avatar already turns a stored media path into a safe image URL, so the icon reuses it rather
    // than adding another <img src> of its own.
    return (
      <span className="rail-icon">
        <Avatar user={{ displayName: community.name, avatarUrl: community.iconUrl }} />
      </span>
    );
  }
  const tile = communityTile(community);
  return <span className={tile.small ? "rail-letters rail-letters-small" : "rail-letters"}>{tile.label}</span>;
}
