import Foundation
import Carbon.HIToolbox
import AppKit

// 全局热键：⌥⌘N 呼出/隐藏主窗口（与 Spotlight 类似）
final class GlobalHotKey {
    static let shared = GlobalHotKey()
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    var onTrigger: (() -> Void)?

    func register(keyCode: UInt32 = UInt32(kVK_ANSI_N),
                  modifiers: UInt32 = UInt32(optionKey | cmdKey)) {
        unregister()
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
            guard let userData else { return noErr }
            let hk = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { hk.onTrigger?() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)

        let id = EventHotKeyID(signature: OSType(0x424E4253), id: 1) // 'BNBS'
        RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    func unregister() {
        if let r = hotKeyRef { UnregisterEventHotKey(r); hotKeyRef = nil }
        if let h = handlerRef { RemoveEventHandler(h); handlerRef = nil }
    }
}
