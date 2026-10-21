import type { LucideIcon, LucideProps } from "lucide-react";
import * as Lucide from "lucide-react";
import * as Pixel from "pixelarticons/react";
import { type ComponentType, forwardRef, type SVGProps } from "react";
import { cn } from "~/lib/utils";

export type { LucideIcon } from "lucide-react";

/** One accessible SVG and one layout box, with drawings selected by theme CSS. */
function themedIcon(
  Outline: LucideIcon,
  Bitmap: ComponentType<SVGProps<SVGSVGElement>>,
): LucideIcon {
  return forwardRef<SVGSVGElement, LucideProps>(function ThemedIcon(
    { className, children, ...props },
    ref,
  ) {
    return (
      <Outline
        aria-hidden={
          !props["aria-label"] && !props["aria-labelledby"] && !children
            ? true
            : undefined
        }
        {...props}
        ref={ref}
        className={cn("themed-icon", className)}
      >
        <Bitmap className="pixel-glyph" stroke="none" aria-hidden="true" />
        {children}
      </Outline>
    );
  });
}

/** Grid-aligned outlines for agent symbols not supplied by Pixelarticons. */
function pixelPath(d: string) {
  return function PixelSymbol(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden="true"
        {...props}
      >
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
    );
  };
}

export const AlertCircle = themedIcon(Lucide.AlertCircle, Pixel.WarningDiamond);
export const ArrowDownIcon = themedIcon(Lucide.ArrowDown, Pixel.ArrowDown);
export const ArrowLeft = themedIcon(Lucide.ArrowLeft, Pixel.ArrowLeft);
export const ArrowUp = themedIcon(Lucide.ArrowUp, Pixel.ArrowUp);
export const ArrowUpRight = themedIcon(Lucide.ArrowUpRight, Pixel.ExternalLink);
export const Baby = themedIcon(
  Lucide.Baby,
  pixelPath(
    "M7 3h10v2h2v4h2v6h-2v4h-2v2H7v-2H5v-4H3V9h2V5h2V3Zm4 0v4h4M8 11v2m8-2v2m-6 4h4",
  ),
);
export const Bell = themedIcon(Lucide.Bell, Pixel.Bell);
export const Bike = themedIcon(
  Lucide.Bike,
  pixelPath(
    "M3 13h6v8H1v-8h2Zm14 0h6v8h-8v-8h2ZM5 17v-2h2v-4h2V9h6v2h2v4h2v2M7 7h4m4-4h4v4M9 9v4h2v4H5",
  ),
);
export const Blocks = themedIcon(Lucide.Blocks, Pixel.Blocks);
export const BookOpen = themedIcon(Lucide.BookOpen, Pixel.BookOpen);
export const Bot = themedIcon(Lucide.Bot, Pixel.Robot);
export const Brain = themedIcon(
  Lucide.Brain,
  pixelPath(
    "M11 5H9V3H5v2H3v4H1v6h2v4h2v2h4v-2h2V5Zm2 0h2V3h4v2h2v4h2v6h-2v4h-2v2h-4v-2h-2V5ZM5 9h2v4H5m14-4h-2v4h2M7 17h4m2 0h4",
  ),
);
export const Briefcase = themedIcon(Lucide.Briefcase, Pixel.Briefcase);
export const Calendar = themedIcon(Lucide.Calendar, Pixel.Calendar);
export const CalendarClock = themedIcon(Lucide.CalendarClock, Pixel.DateTime);
export const Camera = themedIcon(Lucide.Camera, Pixel.Camera);
export const Cat = themedIcon(
  Lucide.Cat,
  pixelPath(
    "M3 3h2v2h2v2h10V5h2V3h2v14h-2v2h-2v2H7v-2H5v-2H3V3Zm4 8v2m10-2v2m-6 2h2m-4 4h6M1 15h4m14 0h4",
  ),
);
export const Check = themedIcon(Lucide.Check, Pixel.Check);
export const CheckCheck = themedIcon(Lucide.CheckCheck, Pixel.CheckDouble);
export const ChefHat = themedIcon(
  Lucide.ChefHat,
  pixelPath(
    "M7 7V5h2V3h6v2h2v2h4v2h2v6h-2v2h-2v4H5v-4H3v-2H1V9h2V7h4Zm-2 10h14M9 11v6m6-6v6",
  ),
);
export const ChevronDown = themedIcon(Lucide.ChevronDown, Pixel.ChevronDown);
export const ChevronLeft = themedIcon(Lucide.ChevronLeft, Pixel.ChevronLeft);
export const ChevronRight = themedIcon(Lucide.ChevronRight, Pixel.ChevronRight);
export const ChevronUpIcon = themedIcon(Lucide.ChevronUp, Pixel.ChevronUp);
export const CircleHelp = themedIcon(Lucide.CircleHelp, Pixel.CircleQuestion);
export const CircleIcon = themedIcon(Lucide.Circle, Pixel.Circle);
export const Clock = themedIcon(Lucide.Clock, Pixel.Clock);
export const Code = themedIcon(Lucide.Code, Pixel.Code);
export const Coffee = themedIcon(Lucide.Coffee, Pixel.Coffee);
export const Compass = themedIcon(Lucide.Compass, Pixel.Compass);
export const Contact = themedIcon(Lucide.Contact, Pixel.Contact);
export const Copy = themedIcon(Lucide.Copy, Pixel.Copy);
export const CornerDownLeft = themedIcon(
  Lucide.CornerDownLeft,
  Pixel.CornerDownLeft,
);
export const Dog = themedIcon(Lucide.Dog, Pixel.Dog);
export const Download = themedIcon(Lucide.Download, Pixel.Download);
export const Dumbbell = themedIcon(
  Lucide.Dumbbell,
  pixelPath("M1 9h4v6H1V9Zm4-4h4v14H5V5Zm4 6h6v2H9m6-8h4v14h-4V5Zm4 4h4v6h-4"),
);
export const ExternalLink = themedIcon(Lucide.ExternalLink, Pixel.ExternalLink);
export const Eye = themedIcon(Lucide.Eye, Pixel.Eye);
export const FileCode2 = themedIcon(Lucide.FileCode2, Pixel.Script);
export const Workflow = themedIcon(Lucide.Workflow, Pixel.GitBranch);
export const FileIcon = themedIcon(Lucide.File, Pixel.File);
export const FileText = themedIcon(Lucide.FileText, Pixel.FileText);
export const Flower2 = themedIcon(
  Lucide.Flower2,
  pixelPath("M9 7V3h6v4h6v6h-6v4H9v-4H3V7h6Zm2 2h2v2h-2V9Zm1 8v6m0-2h6v-4h-4"),
);
export const Folder = themedIcon(Lucide.Folder, Pixel.Folder);
export const Footprints = themedIcon(
  Lucide.Footprints,
  pixelPath(
    "M5 1h4v2h2v6H3V5h2V1Zm-2 12h8v4H3v-4Zm12-8h4v4h2v6h-8V9h2V5Zm-2 14h8v4h-8v-4Z",
  ),
);
export const Gamepad2 = themedIcon(Lucide.Gamepad2, Pixel.Gamepad);
export const Globe = themedIcon(Lucide.Globe, Pixel.Globe);
export const GraduationCap = themedIcon(
  Lucide.GraduationCap,
  pixelPath(
    "M1 7h4V5h4V3h6v2h4v2h4v2h-4v2h-4v2H9v-2H5V9H1V7Zm4 6v6h4v2h6v-2h4v-6m4-4v8",
  ),
);
export const Heart = themedIcon(Lucide.Heart, Pixel.Heart);
export const History = themedIcon(Lucide.History, Pixel.Reload);
export const House = themedIcon(Lucide.House, Pixel.Home);
export const ImageIcon = themedIcon(Lucide.Image, Pixel.Image);
export const ImagePlus = themedIcon(Lucide.ImagePlus, Pixel.Image2Plus);
export const KeyRound = themedIcon(Lucide.KeyRound, Pixel.Key);
export const Leaf = themedIcon(Lucide.Leaf, Pixel.Leaf);
export const Lightbulb = themedIcon(Lucide.Lightbulb, Pixel.Lightbulb);
export const Link2 = themedIcon(Lucide.Link2, Pixel.Link);
export const ListChecks = themedIcon(Lucide.ListChecks, Pixel.ListBox);
export const ListFilter = themedIcon(Lucide.ListFilter, Pixel.Filter);
export const Loader2 = themedIcon(Lucide.Loader2, Pixel.Loading);
export const LogIn = themedIcon(Lucide.LogIn, Pixel.Login);
export const LogOut = themedIcon(Lucide.LogOut, Pixel.Logout);
export const Mail = themedIcon(Lucide.Mail, Pixel.Mail);
const MapIcon = themedIcon(Lucide.Map, Pixel.Map);
export const Maximize2 = themedIcon(Lucide.Maximize2, Pixel.Expand);
export const MessageCircle = themedIcon(Lucide.MessageCircle, Pixel.Comment);
/** Your chats, as a list: Pixelarticons has no pair of bubbles, so its own is one. */
export const MessagesSquare = themedIcon(Lucide.MessagesSquare, Pixel.Message);
export const Monitor = themedIcon(Lucide.Monitor, Pixel.Monitor);
export const Moon = themedIcon(Lucide.Moon, Pixel.Moon);
export const MoreHorizontal = themedIcon(
  Lucide.MoreHorizontal,
  Pixel.MoreHorizontal,
);
export const Music = themedIcon(Lucide.Music, Pixel.Music);
export const Palette = themedIcon(Lucide.Palette, Pixel.ColorsSwatch);
export const PanelLeft = themedIcon(Lucide.PanelLeft, Pixel.Layout);
export const Pause = themedIcon(Lucide.Pause, Pixel.Pause);
export const PenLine = themedIcon(Lucide.PenLine, Pixel.Pencil);
export const Pencil = themedIcon(Lucide.Pencil, Pixel.Pencil);
export const Printer = themedIcon(Lucide.Printer, Pixel.Printer);
export const Plane = themedIcon(
  Lucide.Plane,
  pixelPath(
    "M11 1h2v8h2v2h4v2h2v4h-2v-2h-6v4h2v2h2v2h-4v-2h-2v2H7v-2h2v-2h2v-4H5v2H3v-4h2v-2h4V9h2V1Z",
  ),
);
export const Play = themedIcon(Lucide.Play, Pixel.Play);
export const Plug = themedIcon(Lucide.Plug, Pixel.Plug);
export const Plus = themedIcon(Lucide.Plus, Pixel.Plus);
export const Power = themedIcon(Lucide.Power, Pixel.CirclePower);
export const Puzzle = themedIcon(
  Lucide.Puzzle,
  pixelPath("M3 3h6V1h6v6h6v6h2v6h-6v4H3v-6h4v-6H3V3Z"),
);
export const RefreshCw = themedIcon(Lucide.RefreshCw, Pixel.Reload);
export const Repeat = themedIcon(Lucide.Repeat, Pixel.Repeat);
export const Rocket = themedIcon(
  Lucide.Rocket,
  pixelPath(
    "M9 3h2V1h2v2h2v2h2v12H7V5h2V3Zm2 4h2v4h-2V7ZM7 11H5v2H3v6h4m10-8h2v2h2v6h-4M9 19v2h2v2h2v-2h2v-2",
  ),
);
export const RotateCcw = themedIcon(Lucide.RotateCcw, Pixel.Undo);
export const Search = themedIcon(Lucide.Search, Pixel.Search);
export const Server = themedIcon(Lucide.Server, Pixel.Server);
export const Settings = themedIcon(Lucide.Settings, Pixel.Gear);
export const Shapes = themedIcon(Lucide.Shapes, Pixel.Shapes);
export const Shield = themedIcon(Lucide.Shield, Pixel.Shield);
export const ShieldAlert = themedIcon(
  Lucide.ShieldAlert,
  pixelPath(
    "M3 3h6V1h6v2h6v12h-2v2h-2v2h-2v2H9v-2H7v-2H5v-2H3V3Zm9 4v6m-1 4h2",
  ),
);
export const ScrollText = themedIcon(Lucide.ScrollText, Pixel.Script);
export const ShieldCheck = themedIcon(
  Lucide.ShieldCheck,
  pixelPath(
    "M3 3h6V1h6v2h6v12h-2v2h-2v2h-2v2H9v-2H7v-2H5v-2H3V3Zm4 8h2v2h2v2h2v-2h2v-2h2V9",
  ),
);
export const ShoppingCart = themedIcon(Lucide.ShoppingCart, Pixel.ShoppingCart);
export const SlidersHorizontal = themedIcon(
  Lucide.SlidersHorizontal,
  Pixel.SlidersHorizontal,
);
export const Smartphone = themedIcon(Lucide.Smartphone, Pixel.Smartphone);
export const Smile = themedIcon(Lucide.Smile, Pixel.Smile);
export const Sparkles = themedIcon(Lucide.Sparkles, Pixel.Sparkles);
export const Square = themedIcon(Lucide.Square, Pixel.Stop);
export const SquarePen = themedIcon(Lucide.SquarePen, Pixel.PenSquare);
export const Star = themedIcon(Lucide.Star, Pixel.Star);
export const Stethoscope = themedIcon(
  Lucide.Stethoscope,
  pixelPath(
    "M3 3v8h2v2h2v2h4v-2h2v-2h2V3M1 3h4m8 0h4M9 15v4h2v2h6v-2h2v-6m-2-4h4v4h-4V9Z",
  ),
);
export const Sun = themedIcon(Lucide.Sun, Pixel.Sun);
export const Terminal = themedIcon(Lucide.Terminal, Pixel.Terminal);
export const Trash2 = themedIcon(Lucide.Trash2, Pixel.Trash);
export const TriangleAlert = themedIcon(
  Lucide.TriangleAlert,
  Pixel.WarningDiamond,
);
export const Unplug = themedIcon(Lucide.Unplug, Pixel.Unlink);
export const Upload = themedIcon(Lucide.Upload, Pixel.Upload);
export const UserPlus = themedIcon(Lucide.UserPlus, Pixel.UserPlus);
export const UserRound = themedIcon(Lucide.UserRound, Pixel.User);
export const Users = themedIcon(Lucide.Users, Pixel.Users);
export const Wallet = themedIcon(Lucide.Wallet, Pixel.Wallet);
export const Wrench = themedIcon(Lucide.Wrench, Pixel.Tools);
export const X = themedIcon(Lucide.X, Pixel.Close);
export const Zap = themedIcon(Lucide.Zap, Pixel.Zap);

export {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Copy as CopyIcon,
  MapIcon as Map,
  X as XIcon,
};
