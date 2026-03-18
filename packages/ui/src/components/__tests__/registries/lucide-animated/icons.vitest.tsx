import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { CheckIcon } from "../../../registries/lucide-animated/check";
import { CheckCheckIcon } from "../../../registries/lucide-animated/check-check";
import { CopyIcon } from "../../../registries/lucide-animated/copy";
import { DownloadIcon } from "../../../registries/lucide-animated/download";
import { UploadIcon } from "../../../registries/lucide-animated/upload";
import { SearchIcon } from "../../../registries/lucide-animated/search";
import { SettingsIcon } from "../../../registries/lucide-animated/settings";
import { DeleteIcon } from "../../../registries/lucide-animated/delete";
import { SquarePenIcon } from "../../../registries/lucide-animated/square-pen";
import { PlusIcon } from "../../../registries/lucide-animated/plus";
import { XIcon } from "../../../registries/lucide-animated/x";
import { RefreshCWIcon } from "../../../registries/lucide-animated/refresh-cw";
import { UndoIcon } from "../../../registries/lucide-animated/undo";
import { RedoIcon } from "../../../registries/lucide-animated/redo";

import { ArrowDownIcon } from "../../../registries/lucide-animated/arrow-down";
import { ArrowUpIcon } from "../../../registries/lucide-animated/arrow-up";
import { ArrowLeftIcon } from "../../../registries/lucide-animated/arrow-left";
import { ArrowRightIcon } from "../../../registries/lucide-animated/arrow-right";
import { ChevronDownIcon } from "../../../registries/lucide-animated/chevron-down";
import { ChevronUpIcon } from "../../../registries/lucide-animated/chevron-up";
import { ChevronLeftIcon } from "../../../registries/lucide-animated/chevron-left";
import { ChevronRightIcon } from "../../../registries/lucide-animated/chevron-right";
import { MenuIcon } from "../../../registries/lucide-animated/menu";
import { HomeIcon } from "../../../registries/lucide-animated/home";
import { ExpandIcon } from "../../../registries/lucide-animated/expand";
import { ShrinkIcon } from "../../../registries/lucide-animated/shrink";

import { BellIcon } from "../../../registries/lucide-animated/bell";
import { CircleCheckIcon } from "../../../registries/lucide-animated/circle-check";
import { ShieldCheckIcon } from "../../../registries/lucide-animated/shield-check";
import { EyeIcon } from "../../../registries/lucide-animated/eye";
import { EyeOffIcon } from "../../../registries/lucide-animated/eye-off";
import { LockIcon } from "../../../registries/lucide-animated/lock";
import { LockOpenIcon } from "../../../registries/lucide-animated/lock-open";
import { ZapIcon } from "../../../registries/lucide-animated/zap";
import { HeartIcon } from "../../../registries/lucide-animated/heart";
import { SparklesIcon } from "../../../registries/lucide-animated/sparkles";

import { PlayIcon } from "../../../registries/lucide-animated/play";
import { PauseIcon } from "../../../registries/lucide-animated/pause";
import { VolumeIcon } from "../../../registries/lucide-animated/volume";
import { MicIcon } from "../../../registries/lucide-animated/mic";
import { MicOffIcon } from "../../../registries/lucide-animated/mic-off";
import { MailCheckIcon } from "../../../registries/lucide-animated/mail-check";
import { MessageCircleIcon } from "../../../registries/lucide-animated/message-circle";
import { MessageSquareIcon } from "../../../registries/lucide-animated/message-square";

import { FileTextIcon } from "../../../registries/lucide-animated/file-text";
import { FolderOpenIcon } from "../../../registries/lucide-animated/folder-open";
import { GitBranchIcon } from "../../../registries/lucide-animated/git-branch";
import { GitCommitHorizontalIcon } from "../../../registries/lucide-animated/git-commit-horizontal";
import { TerminalIcon } from "../../../registries/lucide-animated/terminal";
import { CpuIcon } from "../../../registries/lucide-animated/cpu";
import { RocketIcon } from "../../../registries/lucide-animated/rocket";
import { EarthIcon } from "../../../registries/lucide-animated/earth";
import { WifiIcon } from "../../../registries/lucide-animated/wifi";
import { BluetoothIcon } from "../../../registries/lucide-animated/bluetooth";
import { ActivityIcon } from "../../../registries/lucide-animated/activity";

import { UserIcon } from "../../../registries/lucide-animated/user";
import { UsersIcon } from "../../../registries/lucide-animated/users";
import { UserCheckIcon } from "../../../registries/lucide-animated/user-check";
import { GithubIcon } from "../../../registries/lucide-animated/github";
import { TwitterIcon } from "../../../registries/lucide-animated/twitter";
import { LinkedinIcon } from "../../../registries/lucide-animated/linkedin";
import { InstagramIcon } from "../../../registries/lucide-animated/instagram";
import { YoutubeIcon } from "../../../registries/lucide-animated/youtube";
import { FigmaIcon } from "../../../registries/lucide-animated/figma";
import { ChromeIcon } from "../../../registries/lucide-animated/chrome";

import { SunIcon } from "../../../registries/lucide-animated/sun";
import { MoonIcon } from "../../../registries/lucide-animated/moon";
import { CloudRainIcon } from "../../../registries/lucide-animated/cloud-rain";
import { CloudSunIcon } from "../../../registries/lucide-animated/cloud-sun";
import { SnowflakeIcon } from "../../../registries/lucide-animated/snowflake";
import { WindIcon } from "../../../registries/lucide-animated/wind";
import { CompassIcon } from "../../../registries/lucide-animated/compass";
import { MapPinIcon } from "../../../registries/lucide-animated/map-pin";
import { KeyIcon } from "../../../registries/lucide-animated/key";
import { FingerprintIcon } from "../../../registries/lucide-animated/fingerprint";

describe("Lucide Animated Icons", () => {
  describe("action icons", () => {
    const actionIcons = [
      { name: "CheckIcon", Component: CheckIcon },
      { name: "CheckCheckIcon", Component: CheckCheckIcon },
      { name: "CopyIcon", Component: CopyIcon },
      { name: "DownloadIcon", Component: DownloadIcon },
      { name: "UploadIcon", Component: UploadIcon },
      { name: "SearchIcon", Component: SearchIcon },
      { name: "SettingsIcon", Component: SettingsIcon },
      { name: "DeleteIcon", Component: DeleteIcon },
      { name: "SquarePenIcon", Component: SquarePenIcon },
      { name: "PlusIcon", Component: PlusIcon },
      { name: "XIcon", Component: XIcon },
      { name: "RefreshCWIcon", Component: RefreshCWIcon },
      { name: "UndoIcon", Component: UndoIcon },
      { name: "RedoIcon", Component: RedoIcon },
    ];

    it.each(actionIcons)("renders $name without crashing", ({ Component }) => {
      const { container } = render(<Component />);
      expect(container.querySelector("svg")).toBeTruthy();
    });
  });

  describe("navigation icons", () => {
    const navIcons = [
      { name: "ArrowDownIcon", Component: ArrowDownIcon },
      { name: "ArrowUpIcon", Component: ArrowUpIcon },
      { name: "ArrowLeftIcon", Component: ArrowLeftIcon },
      { name: "ArrowRightIcon", Component: ArrowRightIcon },
      { name: "ChevronDownIcon", Component: ChevronDownIcon },
      { name: "ChevronUpIcon", Component: ChevronUpIcon },
      { name: "ChevronLeftIcon", Component: ChevronLeftIcon },
      { name: "ChevronRightIcon", Component: ChevronRightIcon },
      { name: "MenuIcon", Component: MenuIcon },
      { name: "HomeIcon", Component: HomeIcon },
      { name: "ExpandIcon", Component: ExpandIcon },
      { name: "ShrinkIcon", Component: ShrinkIcon },
    ];

    it.each(navIcons)("renders $name without crashing", ({ Component }) => {
      const { container } = render(<Component />);
      expect(container.querySelector("svg")).toBeTruthy();
    });
  });

  describe("status icons", () => {
    const statusIcons = [
      { name: "BellIcon", Component: BellIcon },
      { name: "CircleCheckIcon", Component: CircleCheckIcon },
      { name: "ShieldCheckIcon", Component: ShieldCheckIcon },
      { name: "EyeIcon", Component: EyeIcon },
      { name: "EyeOffIcon", Component: EyeOffIcon },
      { name: "LockIcon", Component: LockIcon },
      { name: "LockOpenIcon", Component: LockOpenIcon },
      { name: "ZapIcon", Component: ZapIcon },
      { name: "HeartIcon", Component: HeartIcon },
      { name: "SparklesIcon", Component: SparklesIcon },
    ];

    it.each(statusIcons)(
      "renders $name without crashing",
      ({ Component }) => {
        const { container } = render(<Component />);
        expect(container.querySelector("svg")).toBeTruthy();
      }
    );
  });

  describe("media icons", () => {
    const mediaIcons = [
      { name: "PlayIcon", Component: PlayIcon },
      { name: "PauseIcon", Component: PauseIcon },
      { name: "VolumeIcon", Component: VolumeIcon },
      { name: "MicIcon", Component: MicIcon },
      { name: "MicOffIcon", Component: MicOffIcon },
      { name: "MailCheckIcon", Component: MailCheckIcon },
      { name: "MessageCircleIcon", Component: MessageCircleIcon },
      { name: "MessageSquareIcon", Component: MessageSquareIcon },
    ];

    it.each(mediaIcons)("renders $name without crashing", ({ Component }) => {
      const { container } = render(<Component />);
      expect(container.querySelector("svg")).toBeTruthy();
    });
  });

  describe("development icons", () => {
    const devIcons = [
      { name: "FileTextIcon", Component: FileTextIcon },
      { name: "FolderOpenIcon", Component: FolderOpenIcon },
      { name: "GitBranchIcon", Component: GitBranchIcon },
      { name: "GitCommitHorizontalIcon", Component: GitCommitHorizontalIcon },
      { name: "TerminalIcon", Component: TerminalIcon },
      { name: "CpuIcon", Component: CpuIcon },
      { name: "RocketIcon", Component: RocketIcon },
      { name: "EarthIcon", Component: EarthIcon },
      { name: "WifiIcon", Component: WifiIcon },
      { name: "BluetoothIcon", Component: BluetoothIcon },
      { name: "ActivityIcon", Component: ActivityIcon },
    ];

    it.each(devIcons)("renders $name without crashing", ({ Component }) => {
      const { container } = render(<Component />);
      expect(container.querySelector("svg")).toBeTruthy();
    });
  });

  describe("social icons", () => {
    const socialIcons = [
      { name: "UserIcon", Component: UserIcon },
      { name: "UsersIcon", Component: UsersIcon },
      { name: "UserCheckIcon", Component: UserCheckIcon },
      { name: "GithubIcon", Component: GithubIcon },
      { name: "TwitterIcon", Component: TwitterIcon },
      { name: "LinkedinIcon", Component: LinkedinIcon },
      { name: "InstagramIcon", Component: InstagramIcon },
      { name: "YoutubeIcon", Component: YoutubeIcon },
      { name: "FigmaIcon", Component: FigmaIcon },
      { name: "ChromeIcon", Component: ChromeIcon },
    ];

    it.each(socialIcons)("renders $name without crashing", ({ Component }) => {
      const { container } = render(<Component />);
      expect(container.querySelector("svg")).toBeTruthy();
    });
  });

  describe("weather icons", () => {
    const weatherIcons = [
      { name: "SunIcon", Component: SunIcon },
      { name: "MoonIcon", Component: MoonIcon },
      { name: "CloudRainIcon", Component: CloudRainIcon },
      { name: "CloudSunIcon", Component: CloudSunIcon },
      { name: "SnowflakeIcon", Component: SnowflakeIcon },
      { name: "WindIcon", Component: WindIcon },
      { name: "CompassIcon", Component: CompassIcon },
      { name: "MapPinIcon", Component: MapPinIcon },
      { name: "KeyIcon", Component: KeyIcon },
      { name: "FingerprintIcon", Component: FingerprintIcon },
    ];

    it.each(weatherIcons)(
      "renders $name without crashing",
      ({ Component }) => {
        const { container } = render(<Component />);
        expect(container.querySelector("svg")).toBeTruthy();
      }
    );
  });
});
